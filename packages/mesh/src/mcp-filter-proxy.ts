#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export const DEFAULT_PROXY_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_PROXY_CALL_TIMEOUT_MS = 300_000;

const MAX_TOOL_PAGES = 1_000;
const MAX_DISCOVERED_TOOLS = 10_000;
const MAX_STARTUP_TIMEOUT_MS = 300_000;
const MAX_CALL_TIMEOUT_MS = 3_600_000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_PAYLOAD_BYTES = 10 * 1024 * 1024;
const MAX_SECRET_BYTES = 16 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const FORBIDDEN_SECRET_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface McpFilterProxyEnvironment {
  readonly [key: string]: string | undefined;
}

export interface McpFilterProxyOptions {
  upstreamUrl?: URL;
  upstreamUrlSecretPath?: string;
  allowTools: string[];
  manifestPath: string;
  headerSecrets: HeaderSecretReference[];
  secretRoot: string;
  startupTimeoutMs: number;
  callTimeoutMs: number;
}

export interface HeaderSecretReference {
  header: string;
  path: string;
}

export interface LoadedHeaderSecrets {
  headers: Record<string, string>;
  redact(message: string): string;
}

export interface LoadedUpstreamUrlSecret {
  url: URL;
  redact(message: string): string;
}

export interface CreateFilteringServerOptions {
  upstreamClient: Client;
  allowTools: readonly string[];
  startupTimeoutMs?: number;
  callTimeoutMs?: number;
}

export interface ToolManifestMetadata {
  name: string;
  version: string;
  protocolVersion: string;
}

export interface McpToolManifest {
  manifestVersion: 1;
  encoding: "gzip-base64";
  generatedAt: string;
  upstream: ToolManifestMetadata;
  allowlist: string[];
  allowlistSha256: string;
  payloadSha256: string;
  schemaSha256: string;
  toolsGzipBase64: string | string[];
}

export interface LoadedMcpToolManifest extends McpToolManifest {
  tools: Tool[];
}

export interface CreateManifestFilteringServerOptions {
  upstreamClient: Client;
  manifest: LoadedMcpToolManifest;
  validation: Promise<void>;
  callTimeoutMs?: number;
}

export interface FilteringServer {
  server: Server;
  tools: readonly Tool[];
  disable(): void;
}

export interface McpFilterProxyRuntime {
  readonly server: Server;
  readonly upstreamClient: Client;
  readonly tools: readonly Tool[];
  readonly manifest: LoadedMcpToolManifest;
  readonly validation: Promise<void>;
  close(): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`Cannot hash non-JSON value of type ${typeof value}.`);
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function parseManifestMetadata(value: unknown): ToolManifestMetadata {
  const metadata = record(value, "MCP tool manifest upstream metadata");
  return {
    name: nonEmptyString(metadata.name, "MCP tool manifest upstream name"),
    version: nonEmptyString(metadata.version, "MCP tool manifest upstream version"),
    protocolVersion: nonEmptyString(
      metadata.protocolVersion,
      "MCP tool manifest protocol version",
    ),
  };
}

function validateGeneratedAt(value: unknown): string {
  const generatedAt = nonEmptyString(value, "MCP tool manifest generatedAt");
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("MCP tool manifest generatedAt must be an ISO timestamp.");
  }
  return generatedAt;
}

function validateManifestHash(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${name} must be a sha256 digest.`);
  }
  return value;
}

function parseManifestTools(payload: unknown): Tool[] {
  if (!Array.isArray(payload)) throw new Error("MCP tool manifest payload must be an array.");
  if (payload.length > MAX_DISCOVERED_TOOLS) {
    throw new Error(`MCP tool manifest contains more than ${MAX_DISCOVERED_TOOLS} tools.`);
  }
  return payload.map((tool, index) => {
    const parsed = ToolSchema.safeParse(tool);
    if (!parsed.success) {
      throw new Error(`MCP tool manifest tool ${index} is invalid: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

function toolContracts(tools: readonly Tool[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    execution: tool.execution,
  }));
}

export function createToolManifest(
  tools: readonly Tool[],
  upstream: ToolManifestMetadata,
  generatedAt = new Date().toISOString(),
): McpToolManifest {
  const parsedTools = parseManifestTools(clone(tools));
  const allowlist = validateAllowlist(parsedTools.map((tool) => tool.name));
  const metadata = parseManifestMetadata(upstream);
  const timestamp = validateGeneratedAt(generatedAt);
  const payload = gzipSync(Buffer.from(JSON.stringify(parsedTools)), { level: 9 });

  return {
    manifestVersion: 1,
    encoding: "gzip-base64",
    generatedAt: timestamp,
    upstream: metadata,
    allowlist,
    allowlistSha256: sha256(allowlist),
    payloadSha256: sha256(parsedTools),
    schemaSha256: sha256(toolContracts(parsedTools)),
    toolsGzipBase64: payload.toString("base64"),
  };
}

export function loadToolManifest(
  manifestPath: string,
  expectedAllowTools?: readonly string[],
): LoadedMcpToolManifest {
  const path = resolve(manifestPath);
  let descriptor: number | undefined;
  let source: string;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error("MCP tool manifest path must be a regular file.");
    if (stats.size < 1 || stats.size > MAX_MANIFEST_BYTES) {
      throw new Error(`MCP tool manifest must be from 1 through ${MAX_MANIFEST_BYTES} bytes.`);
    }
    source = readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("MCP tool manifest")) throw error;
    throw new Error("Unable to read the MCP tool manifest.", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new Error("MCP tool manifest is not valid JSON.", { cause: error });
  }
  const manifest = record(raw, "MCP tool manifest");
  if (manifest.manifestVersion !== 1) {
    throw new Error("Unsupported MCP tool manifest version.");
  }
  if (manifest.encoding !== "gzip-base64") {
    throw new Error("Unsupported MCP tool manifest encoding.");
  }

  const allowlistValue = manifest.allowlist;
  if (
    !Array.isArray(allowlistValue) ||
    allowlistValue.some((tool) => typeof tool !== "string")
  ) {
    throw new Error("MCP tool manifest allowlist must be a string array.");
  }
  const allowlist = validateAllowlist(allowlistValue);
  if (expectedAllowTools) {
    const expected = validateAllowlist(expectedAllowTools);
    if (
      expected.length !== allowlist.length ||
      expected.some((tool, index) => tool !== allowlist[index])
    ) {
      throw new Error("MCP tool manifest allowlist does not match configured allowlist.");
    }
  }

  const allowlistSha256 = validateManifestHash(
    manifest.allowlistSha256,
    "MCP tool manifest allowlistSha256",
  );
  if (allowlistSha256 !== sha256(allowlist)) {
    throw new Error("MCP tool manifest allowlist hash does not match its contents.");
  }

  const encodedValue = manifest.toolsGzipBase64;
  const encoded = Array.isArray(encodedValue)
    ? encodedValue
        .map((chunk) =>
          nonEmptyString(chunk, "MCP tool manifest toolsGzipBase64 chunk"),
        )
        .join("")
    : nonEmptyString(encodedValue, "MCP tool manifest toolsGzipBase64");
  if (
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  ) {
    throw new Error("MCP tool manifest payload is not valid base64.");
  }

  let tools: Tool[];
  try {
    const payload = gunzipSync(Buffer.from(encoded, "base64"), {
      maxOutputLength: MAX_MANIFEST_PAYLOAD_BYTES,
    }).toString("utf8");
    tools = parseManifestTools(JSON.parse(payload));
  } catch (error) {
    throw new Error("MCP tool manifest payload is invalid.", { cause: error });
  }

  const toolNames = validateAllowlist(tools.map((tool) => tool.name));
  if (
    toolNames.length !== allowlist.length ||
    toolNames.some((tool, index) => tool !== allowlist[index])
  ) {
    throw new Error("MCP tool manifest payload inventory does not match its allowlist.");
  }

  const payloadSha256 = validateManifestHash(
    manifest.payloadSha256,
    "MCP tool manifest payloadSha256",
  );
  if (payloadSha256 !== sha256(tools)) {
    throw new Error("MCP tool manifest payload hash does not match its payload.");
  }
  const schemaSha256 = validateManifestHash(
    manifest.schemaSha256,
    "MCP tool manifest schemaSha256",
  );
  if (schemaSha256 !== sha256(toolContracts(tools))) {
    throw new Error("MCP tool manifest schema hash does not match its payload.");
  }

  return {
    manifestVersion: 1,
    encoding: "gzip-base64",
    generatedAt: validateGeneratedAt(manifest.generatedAt),
    upstream: parseManifestMetadata(manifest.upstream),
    allowlist,
    allowlistSha256,
    payloadSha256,
    schemaSha256,
    toolsGzipBase64: encoded,
    tools,
  };
}

export function assertManifestMatchesUpstream(
  manifest: LoadedMcpToolManifest,
  upstreamTools: readonly Tool[],
): void {
  const parsedTools = parseManifestTools(clone(upstreamTools));
  const names = validateAllowlist(parsedTools.map((tool) => tool.name));
  if (
    names.length !== manifest.allowlist.length ||
    names.some((tool, index) => tool !== manifest.allowlist[index])
  ) {
    throw new Error("Upstream MCP inventory does not match the pinned tool manifest.");
  }
  if (sha256(toolContracts(parsedTools)) !== manifest.schemaSha256) {
    throw new Error("Upstream MCP schemas do not match the pinned tool manifest.");
  }
}

function optionValue(
  argv: readonly string[],
  index: number,
): { key: string; value: string; consumed: number } {
  const argument = argv[index];
  if (!argument?.startsWith("--")) {
    throw new Error(`Unexpected positional argument: ${argument ?? ""}`);
  }

  const equals = argument.indexOf("=");
  if (equals >= 0) {
    return {
      key: argument.slice(0, equals),
      value: argument.slice(equals + 1),
      consumed: 1,
    };
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${argument} requires a value.`);
  }
  return { key: argument, value, consumed: 2 };
}

function parseToolList(raw: string, source: string): string[] {
  const value = raw.trim();
  if (!value) throw new Error(`${source} must contain at least one tool name.`);

  if (value.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${source} must be a comma-separated list or a JSON string array.`);
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      throw new Error(`${source} must be a comma-separated list or a JSON string array.`);
    }
    return parsed.map((entry) => entry.trim());
  }

  return value.split(",").map((entry) => entry.trim());
}

function parseTimeout(raw: string | undefined, name: string, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 through ${max}.`);
  }
  return parsed;
}

export function validateUpstreamUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("The MCP filter upstream URL must be a valid HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The MCP filter upstream URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "The MCP filter upstream URL must not contain credentials, query parameters, or a fragment.",
    );
  }
  return url;
}

export function validateAllowlist(tools: readonly string[]): string[] {
  if (tools.length === 0) throw new Error("The MCP filter allowlist must not be empty.");

  const seen = new Set<string>();
  return tools.map((tool) => {
    const normalized = tool.trim();
    if (!normalized || /[\u0000-\u001f\u007f,]/u.test(normalized)) {
      throw new Error(`Invalid MCP tool name in allowlist: ${JSON.stringify(tool)}.`);
    }
    if (seen.has(normalized)) {
      throw new Error(`Duplicate MCP tool in allowlist: ${normalized}.`);
    }
    seen.add(normalized);
    return normalized;
  });
}

function defaultSecretRoot(home = homedir()): string {
  return resolve(home, ".secrets");
}

function pathIsWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return Boolean(child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function parseHeaderSecretReference(
  value: string,
  secretRoot = defaultSecretRoot(),
): HeaderSecretReference {
  const separator = value.indexOf("=");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("--header-secret must use HEADER=/absolute/secret/path syntax.");
  }
  const header = value.slice(0, separator).trim();
  const path = value.slice(separator + 1).trim();
  if (!HEADER_NAME_PATTERN.test(header)) {
    throw new Error(`Invalid secret header name: ${JSON.stringify(header)}.`);
  }
  if (FORBIDDEN_SECRET_HEADERS.has(header.toLowerCase())) {
    throw new Error(`Secret header is reserved by the MCP transport: ${header}.`);
  }
  if (!isAbsolute(path)) {
    throw new Error("Secret header path must be absolute.");
  }

  const resolvedRoot = resolve(secretRoot);
  const resolvedPath = resolve(path);
  if (!pathIsWithin(resolvedRoot, resolvedPath)) {
    throw new Error("Secret header path must be beneath ~/.secrets.");
  }
  return { header, path: resolvedPath };
}

function assertPrivateDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory.`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or other permissions.`);
  }
  if (process.getuid && stats.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user.`);
  }
}

function formatSecretHeader(header: string, secret: string): string {
  if (
    header.toLowerCase() === "authorization" &&
    !/^[A-Za-z][A-Za-z0-9+.-]*\s+/u.test(secret)
  ) {
    return `Bearer ${secret}`;
  }
  return secret;
}

export function loadHeaderSecretHeaders(
  references: readonly HeaderSecretReference[],
  secretRoot = defaultSecretRoot(),
): LoadedHeaderSecrets {
  if (references.length === 0) {
    return { headers: {}, redact: (message) => message };
  }

  const resolvedRoot = resolve(secretRoot);
  assertPrivateDirectory(resolvedRoot, "Secret root");
  const realRoot = realpathSync(resolvedRoot);
  const headers: Record<string, string> = {};
  const seenHeaders = new Set<string>();
  const redactions: string[] = [];

  for (const reference of references) {
    const parsed = parseHeaderSecretReference(
      `${reference.header}=${reference.path}`,
      resolvedRoot,
    );
    const normalizedHeader = parsed.header.toLowerCase();
    if (seenHeaders.has(normalizedHeader)) {
      throw new Error(`Duplicate secret header: ${parsed.header}.`);
    }
    seenHeaders.add(normalizedHeader);

    const childPath = relative(resolvedRoot, parsed.path);
    let currentDirectory = resolvedRoot;
    for (const component of childPath.split(sep).slice(0, -1)) {
      currentDirectory = join(currentDirectory, component);
      assertPrivateDirectory(currentDirectory, "Secret path directory");
    }

    const lexicalStats = lstatSync(parsed.path);
    if (lexicalStats.isSymbolicLink() || !lexicalStats.isFile()) {
      throw new Error("Secret header file must be a non-symlink regular file.");
    }
    const realPath = realpathSync(parsed.path);
    if (!pathIsWithin(realRoot, realPath)) {
      throw new Error("Secret header file resolves outside ~/.secrets.");
    }
    const permissions = lexicalStats.mode & 0o777;
    if (process.platform !== "win32" && permissions !== 0o400 && permissions !== 0o600) {
      throw new Error("Secret header file must be owner-readable and mode 0600 or stricter.");
    }
    if (process.getuid && lexicalStats.uid !== process.getuid()) {
      throw new Error("Secret header file must be owned by the current user.");
    }
    if (lexicalStats.nlink !== 1) {
      throw new Error("Secret header file must not have additional hard links.");
    }
    if (lexicalStats.size < 1 || lexicalStats.size > MAX_SECRET_BYTES) {
      throw new Error(`Secret header file must be from 1 through ${MAX_SECRET_BYTES} bytes.`);
    }

    let descriptor: number | undefined;
    let buffer: Buffer | undefined;
    let secret: string;
    try {
      descriptor = openSync(
        parsed.path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const openedStats = fstatSync(descriptor);
      if (
        !openedStats.isFile() ||
        openedStats.dev !== lexicalStats.dev ||
        openedStats.ino !== lexicalStats.ino
      ) {
        throw new Error("Secret header file changed while opening.");
      }
      buffer = readFileSync(descriptor);
      secret = buffer.toString("utf8").replace(/[\r\n]+$/u, "");
    } finally {
      buffer?.fill(0);
      if (descriptor !== undefined) closeSync(descriptor);
    }

    if (
      !secret ||
      secret !== secret.trim() ||
      /[\u0000-\u001f\u007f]/u.test(secret)
    ) {
      throw new Error("Secret header file must contain one non-empty header value.");
    }
    const headerValue = formatSecretHeader(parsed.header, secret);
    headers[parsed.header] = headerValue;
    redactions.push(secret, headerValue);
  }

  const uniqueRedactions = [...new Set(redactions)].sort(
    (left, right) => right.length - left.length,
  );
  return {
    headers,
    redact(message: string): string {
      return uniqueRedactions.reduce(
        (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
        message,
      );
    },
  };
}

export function parseUpstreamUrlSecretPath(
  value: string,
  secretRoot = defaultSecretRoot(),
): string {
  return parseHeaderSecretReference(
    `X-Mcp-Private-Upstream-Url=${value}`,
    secretRoot,
  ).path;
}

export function loadUpstreamUrlSecret(
  path: string,
  secretRoot = defaultSecretRoot(),
): LoadedUpstreamUrlSecret {
  const reference = parseHeaderSecretReference(
    `X-Mcp-Private-Upstream-Url=${path}`,
    secretRoot,
  );
  const loaded = loadHeaderSecretHeaders([reference], secretRoot);
  const raw = loaded.headers["X-Mcp-Private-Upstream-Url"];
  if (!raw) throw new Error("Private upstream URL file is empty.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Private upstream URL file must contain a valid HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Private upstream URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.hash) {
    throw new Error(
      "Private upstream URL must use query credentials, not userinfo or fragments.",
    );
  }

  const querySecrets = [
    ...url.searchParams.values(),
    ...url.search
      .slice(1)
      .split("&")
      .map((entry) => entry.slice(entry.indexOf("=") + 1))
      .filter(Boolean),
  ].sort((left, right) => right.length - left.length);
  return {
    url,
    redact(message: string): string {
      return querySecrets.reduce(
        (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
        loaded.redact(message),
      );
    },
  };
}

export function createUpstreamRequestInit(
  secretHeaders: LoadedHeaderSecrets,
): RequestInit {
  return {
    redirect: "error",
    headers: { ...secretHeaders.headers },
  };
}

/**
 * CLI values override environment values. The allowlist accepts either a
 * comma-separated string or a JSON string array.
 */
export function parseMcpFilterProxyOptions(
  argv: readonly string[] = process.argv.slice(2),
  env: McpFilterProxyEnvironment = process.env,
): McpFilterProxyOptions {
  let upstream: string | undefined;
  let upstreamUrlSecretPath: string | undefined;
  let allowList: string | undefined;
  const individualTools: string[] = [];
  const headerSecretValues: string[] = [];
  let manifestPath: string | undefined;
  let startupTimeout: string | undefined;
  let callTimeout: string | undefined;

  for (let index = 0; index < argv.length; ) {
    const parsed = optionValue(argv, index);
    index += parsed.consumed;
    switch (parsed.key) {
      case "--upstream-url":
        if (upstream !== undefined) throw new Error("--upstream-url may only be specified once.");
        upstream = parsed.value;
        break;
      case "--upstream-url-secret":
        if (upstreamUrlSecretPath !== undefined) {
          throw new Error("--upstream-url-secret may only be specified once.");
        }
        upstreamUrlSecretPath = parsed.value;
        break;
      case "--allow-tools":
      case "--allowlist":
        if (allowList !== undefined) throw new Error(`${parsed.key} may only be specified once.`);
        allowList = parsed.value;
        break;
      case "--allow-tool":
        individualTools.push(parsed.value);
        break;
      case "--manifest":
      case "--manifest-path":
        if (manifestPath !== undefined) {
          throw new Error(`${parsed.key} may only be specified once.`);
        }
        manifestPath = parsed.value;
        break;
      case "--header-secret":
        headerSecretValues.push(parsed.value);
        break;
      case "--startup-timeout-ms":
        if (startupTimeout !== undefined) {
          throw new Error("--startup-timeout-ms may only be specified once.");
        }
        startupTimeout = parsed.value;
        break;
      case "--call-timeout-ms":
        if (callTimeout !== undefined) {
          throw new Error("--call-timeout-ms may only be specified once.");
        }
        callTimeout = parsed.value;
        break;
      default:
        throw new Error(`Unknown MCP filter option: ${parsed.key}.`);
    }
  }

  if (allowList !== undefined && individualTools.length > 0) {
    throw new Error("Use either --allow-tools or repeated --allow-tool values, not both.");
  }

  if (upstream !== undefined && upstreamUrlSecretPath !== undefined) {
    throw new Error("Use either --upstream-url or --upstream-url-secret, not both.");
  }
  const upstreamRaw =
    upstream ??
    (upstreamUrlSecretPath === undefined
      ? env.MCP_FILTER_UPSTREAM_URL ?? env.AGENT_MESH_PIECES_URL
      : undefined);
  if (!upstreamRaw?.trim() && upstreamUrlSecretPath === undefined) {
    throw new Error(
      "MCP filter upstream URL is required via --upstream-url, --upstream-url-secret, or MCP_FILTER_UPSTREAM_URL.",
    );
  }

  const rawTools =
    allowList ??
    (individualTools.length > 0 ? JSON.stringify(individualTools) : env.MCP_FILTER_ALLOW_TOOLS);
  if (rawTools === undefined) {
    throw new Error(
      "MCP filter allowlist is required via --allow-tools, --allow-tool, or MCP_FILTER_ALLOW_TOOLS.",
    );
  }
  const manifestRaw = manifestPath ?? env.MCP_FILTER_MANIFEST_PATH;
  if (!manifestRaw?.trim()) {
    throw new Error(
      "MCP filter manifest is required via --manifest or MCP_FILTER_MANIFEST_PATH.",
    );
  }
  const secretRoot = defaultSecretRoot(env.HOME?.trim() || homedir());

  return {
    upstreamUrl: upstreamRaw?.trim()
      ? validateUpstreamUrl(upstreamRaw)
      : undefined,
    upstreamUrlSecretPath:
      upstreamUrlSecretPath === undefined
        ? undefined
        : parseUpstreamUrlSecretPath(upstreamUrlSecretPath, secretRoot),
    allowTools: validateAllowlist(parseToolList(rawTools, "MCP filter allowlist")),
    manifestPath: resolve(manifestRaw.trim()),
    headerSecrets: headerSecretValues.map((value) =>
      parseHeaderSecretReference(value, secretRoot),
    ),
    secretRoot,
    startupTimeoutMs: parseTimeout(
      startupTimeout ?? env.MCP_FILTER_STARTUP_TIMEOUT_MS,
      "MCP filter startup timeout",
      DEFAULT_PROXY_STARTUP_TIMEOUT_MS,
      MAX_STARTUP_TIMEOUT_MS,
    ),
    callTimeoutMs: parseTimeout(
      callTimeout ?? env.MCP_FILTER_CALL_TIMEOUT_MS,
      "MCP filter call timeout",
      DEFAULT_PROXY_CALL_TIMEOUT_MS,
      MAX_CALL_TIMEOUT_MS,
    ),
  };
}

export async function discoverAllowedTools(
  client: Client,
  allowTools: readonly string[],
  startupTimeoutMs = DEFAULT_PROXY_STARTUP_TIMEOUT_MS,
): Promise<Tool[]> {
  startupTimeoutMs = parseTimeout(
    String(startupTimeoutMs),
    "MCP filter startup timeout",
    DEFAULT_PROXY_STARTUP_TIMEOUT_MS,
    MAX_STARTUP_TIMEOUT_MS,
  );
  const allowlist = validateAllowlist(allowTools);
  const discovered = new Map<string, Tool>();
  const seenCursors = new Set<string>();
  const signal = AbortSignal.timeout(startupTimeoutMs);
  let cursor: string | undefined;

  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await client.listTools(
      cursor ? { cursor } : undefined,
      {
        signal,
        timeout: startupTimeoutMs,
        maxTotalTimeout: startupTimeoutMs,
        resetTimeoutOnProgress: false,
      },
    );

    for (const tool of result.tools) {
      if (discovered.has(tool.name)) {
        throw new Error(`Upstream MCP server advertised duplicate tool: ${tool.name}.`);
      }
      discovered.set(tool.name, clone(tool));
      if (discovered.size > MAX_DISCOVERED_TOOLS) {
        throw new Error(`Upstream MCP server advertised more than ${MAX_DISCOVERED_TOOLS} tools.`);
      }
    }

    cursor = result.nextCursor;
    if (!cursor) break;
    if (seenCursors.has(cursor)) {
      throw new Error("Upstream MCP tools/list returned a repeated pagination cursor.");
    }
    seenCursors.add(cursor);
    if (page === MAX_TOOL_PAGES - 1) {
      throw new Error(`Upstream MCP tools/list exceeded ${MAX_TOOL_PAGES} pages.`);
    }
  }

  const missing = allowlist.filter((name) => !discovered.has(name));
  if (missing.length > 0) {
    throw new Error(`Upstream MCP server is missing allowlisted tools: ${missing.join(", ")}.`);
  }

  return allowlist.map((name) => clone(discovered.get(name)!));
}

async function waitForValidation(
  validation: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      cleanup();
      rejectPromise(signal.reason);
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    validation.then(
      () => {
        cleanup();
        resolvePromise();
      },
      (error: unknown) => {
        cleanup();
        rejectPromise(error);
      },
    );
  });
}

function createFilteringBoundary(options: {
  upstreamClient: Client;
  tools: readonly Tool[];
  validation: Promise<void>;
  callTimeoutMs: number;
}): FilteringServer {
  const tools = parseManifestTools(clone(options.tools));
  const allowlist = new Set(tools.map((tool) => tool.name));
  let enabled = true;
  void options.validation.catch(() => undefined);

  const server = new Server(
    { name: "agent-mesh-mcp-filter", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Pinned filtering boundary. Tool calls wait for successful upstream inventory and schema validation.",
      enforceStrictCapabilities: true,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (request.params?.cursor) {
      throw new McpError(ErrorCode.InvalidParams, "This MCP proxy does not paginate tools.");
    }
    return { tools: clone(tools) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!enabled) throw new McpError(ErrorCode.InternalError, "MCP upstream is unavailable.");
    if (!allowlist.has(request.params.name)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Tool is not exposed by this MCP proxy: ${request.params.name}.`,
      );
    }

    const startedAt = Date.now();
    const timeoutSignal = AbortSignal.timeout(options.callTimeoutMs);
    const signal = AbortSignal.any([extra.signal, timeoutSignal]);
    await waitForValidation(options.validation, signal);
    if (!enabled) throw new McpError(ErrorCode.InternalError, "MCP upstream is unavailable.");

    const remainingMs = options.callTimeoutMs - (Date.now() - startedAt);
    if (remainingMs < 1) {
      throw new McpError(ErrorCode.RequestTimeout, "MCP tool call timed out.");
    }
    const result = await options.upstreamClient.callTool(
      clone(request.params),
      CallToolResultSchema,
      {
        signal,
        timeout: remainingMs,
        maxTotalTimeout: remainingMs,
        resetTimeoutOnProgress: false,
      },
    );
    return clone(CallToolResultSchema.parse(result));
  });

  return {
    server,
    tools: clone(tools),
    disable() {
      enabled = false;
    },
  };
}

export async function createFilteringServer(
  options: CreateFilteringServerOptions,
): Promise<FilteringServer> {
  const callTimeoutMs = parseTimeout(
    String(options.callTimeoutMs ?? DEFAULT_PROXY_CALL_TIMEOUT_MS),
    "MCP filter call timeout",
    DEFAULT_PROXY_CALL_TIMEOUT_MS,
    MAX_CALL_TIMEOUT_MS,
  );
  const tools = await discoverAllowedTools(
    options.upstreamClient,
    options.allowTools,
    options.startupTimeoutMs,
  );
  return createFilteringBoundary({
    upstreamClient: options.upstreamClient,
    tools,
    validation: Promise.resolve(),
    callTimeoutMs,
  });
}

export function createManifestFilteringServer(
  options: CreateManifestFilteringServerOptions,
): FilteringServer {
  const callTimeoutMs = parseTimeout(
    String(options.callTimeoutMs ?? DEFAULT_PROXY_CALL_TIMEOUT_MS),
    "MCP filter call timeout",
    DEFAULT_PROXY_CALL_TIMEOUT_MS,
    MAX_CALL_TIMEOUT_MS,
  );
  return createFilteringBoundary({
    upstreamClient: options.upstreamClient,
    tools: options.manifest.tools,
    validation: options.validation,
    callTimeoutMs,
  });
}

export async function startMcpFilterProxy(
  options: McpFilterProxyOptions,
  downstreamTransport: Transport = new StdioServerTransport(),
): Promise<McpFilterProxyRuntime> {
  if (options.upstreamUrl && options.upstreamUrlSecretPath) {
    throw new Error("Use either a public or private upstream URL, not both.");
  }
  const privateUpstream = options.upstreamUrlSecretPath
    ? loadUpstreamUrlSecret(options.upstreamUrlSecretPath, options.secretRoot)
    : undefined;
  const upstreamUrl = options.upstreamUrl
    ? validateUpstreamUrl(options.upstreamUrl.toString())
    : privateUpstream?.url;
  if (!upstreamUrl) throw new Error("MCP filter upstream URL is required.");
  const allowTools = validateAllowlist(options.allowTools);
  const manifest = loadToolManifest(options.manifestPath, allowTools);
  const secretHeaders = loadHeaderSecretHeaders(
    options.headerSecrets,
    options.secretRoot,
  );
  const redact = (message: string): string =>
    privateUpstream?.redact(secretHeaders.redact(message)) ??
    secretHeaders.redact(message);
  const startupTimeoutMs = parseTimeout(
    String(options.startupTimeoutMs),
    "MCP filter startup timeout",
    DEFAULT_PROXY_STARTUP_TIMEOUT_MS,
    MAX_STARTUP_TIMEOUT_MS,
  );
  const callTimeoutMs = parseTimeout(
    String(options.callTimeoutMs),
    "MCP filter call timeout",
    DEFAULT_PROXY_CALL_TIMEOUT_MS,
    MAX_CALL_TIMEOUT_MS,
  );
  const upstreamClient = new Client(
    { name: "agent-mesh-mcp-filter-upstream", version: "0.1.0" },
    { capabilities: {}, enforceStrictCapabilities: true },
  );
  const upstreamTransport = new StreamableHTTPClientTransport(upstreamUrl, {
    requestInit: createUpstreamRequestInit(secretHeaders),
    reconnectionOptions: {
      initialReconnectionDelay: 500,
      maxReconnectionDelay: 2_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 1,
    },
  });

  let resolveValidation!: () => void;
  let rejectValidation!: (error: unknown) => void;
  const validation = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveValidation = resolvePromise;
    rejectValidation = rejectPromise;
  });
  const filtering = createManifestFilteringServer({
    upstreamClient,
    manifest,
    validation,
    callTimeoutMs,
  });
  const activeFiltering = filtering;
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    activeFiltering.disable();
    await Promise.allSettled([activeFiltering.server.close(), upstreamClient.close()]);
  };

  activeFiltering.server.onclose = () => {
    void close();
  };
  upstreamClient.onclose = () => {
    if (closing) return;
    console.error("[mcp-filter-proxy] upstream connection closed");
    activeFiltering.disable();
  };
  upstreamClient.onerror = (error) => {
    if (closing) return;
    console.error(
      `[mcp-filter-proxy] upstream error: ${redact(error.message)}`,
    );
    activeFiltering.disable();
  };

  try {
    await activeFiltering.server.connect(downstreamTransport);
    void (async (): Promise<void> => {
      await upstreamClient.connect(upstreamTransport, {
        timeout: startupTimeoutMs,
        maxTotalTimeout: startupTimeoutMs,
      });
      const upstreamTools = await discoverAllowedTools(
        upstreamClient,
        allowTools,
        startupTimeoutMs,
      );
      assertManifestMatchesUpstream(manifest, upstreamTools);
    })().then(resolveValidation, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      rejectValidation(new Error(redact(message)));
    });

    return {
      server: activeFiltering.server,
      upstreamClient,
      tools: activeFiltering.tools,
      manifest,
      validation,
      close,
    };
  } catch (error) {
    rejectValidation(error);
    await close();
    throw error;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && resolve(entry) === fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  let runtime: McpFilterProxyRuntime | undefined;
  const shutdown = async (): Promise<void> => {
    await runtime?.close();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => {
      process.exitCode = 0;
    });
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => {
      process.exitCode = 0;
    });
  });

  try {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 24) {
      throw new Error(`Node.js 24+ is required (found ${process.version}).`);
    }
    const options = parseMcpFilterProxyOptions();
    runtime = await startMcpFilterProxy(options);
    console.error(
      `[mcp-filter-proxy] manifest ready (${runtime.tools.length} tools, validation=pending, pid=${process.pid})`,
    );
    void runtime.validation.then(
      () => {
        console.error(
          `[mcp-filter-proxy] upstream validated (${runtime?.manifest.schemaSha256})`,
        );
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[mcp-filter-proxy] upstream validation failed: ${message}`);
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcp-filter-proxy] startup failed: ${message}`);
    process.exitCode = 1;
  }
}
