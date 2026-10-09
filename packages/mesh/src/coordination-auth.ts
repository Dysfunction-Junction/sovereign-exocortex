import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { stateDirectory } from "./security.js";
import type {
  CoordinationContext,
  ManagedPeerContext,
} from "./types.js";

const KEY_BYTES = 32;

function keyPath(): string {
  return join(stateDirectory(), "coordination.key");
}

function readKey(): Buffer {
  const path = keyPath();
  mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 });
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}`;
    const fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, randomBytes(KEY_BYTES));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, 0o600);
    try {
      linkSync(temporary, path);
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError;
    } finally {
      unlinkSync(temporary);
    }
  }
  const info = lstatSync(path);
  const uid = process.getuid?.();
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
    (uid !== undefined && info.uid !== uid)
  ) {
    throw new Error("Coordination capability key is not a private owner file.");
  }
  const key = readFileSync(path);
  if (key.byteLength !== KEY_BYTES) throw new Error("Coordination capability key is invalid.");
  return key;
}

function payload(context: CoordinationContext): string {
  return `${context.origin}\0${context.swarmId}\0${context.memberId}`;
}

export function coordinationCapability(context: CoordinationContext): string {
  return createHmac("sha256", readKey()).update(payload(context)).digest("hex");
}

export function agentMeshHmac(domain: string, value: string): string {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(domain)) {
    throw new Error("Invalid agent-mesh HMAC domain.");
  }
  return createHmac("sha256", readKey())
    .update(domain)
    .update("\0")
    .update(value)
    .digest("hex");
}

export function verifyCoordinationCapability(
  context: CoordinationContext,
  candidate: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(candidate)) return false;
  const expected = Buffer.from(coordinationCapability(context), "hex");
  const actual = Buffer.from(candidate, "hex");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function peerPayload(context: ManagedPeerContext): string {
  return [
    context.origin,
    context.agentId,
    context.memberId,
    String(context.membershipGeneration),
    context.taskId ?? "",
    context.runId ?? "",
    context.causalRoot ?? "",
    (context.causalPath ?? []).join(","),
  ].join("\0");
}

export function managedPeerCapability(
  context: ManagedPeerContext,
): string {
  return agentMeshHmac("managed-peer-capability", peerPayload(context));
}

export function verifyManagedPeerCapability(
  context: ManagedPeerContext,
  candidate: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(candidate)) return false;
  const expected = Buffer.from(managedPeerCapability(context), "hex");
  const actual = Buffer.from(candidate, "hex");
  return (
    expected.byteLength === actual.byteLength &&
    timingSafeEqual(expected, actual)
  );
}
