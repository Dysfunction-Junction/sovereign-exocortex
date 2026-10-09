import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  buildSafeEnv,
  ensurePrivateDirectory,
  redactSecrets,
  stateDirectory,
} from "./security.js";

const execFileAsync = promisify(execFile);

// MESH[2026-07-25T20:41Z][agent:claude-builder][direction:user/1]
// What: replaced the one-sentence approval prompt with a structured request that
//   renders both the native dialog text and a read-only local detail page.
// Why: a human asked to apply a patch, approve a playbook, rewrite an instruction
//   set, or destroy credentials saw a single sentence with no digest, no affected
//   paths, no evidence, and no statement of reversibility.
// Aligns-with: direction user revision 1 (structured summary plus rich local
//   detail page; the authorization surface itself is unchanged).
// Trust boundary: authorization MUST stay in the osascript dialog. Delegated child
//   sandboxes are not granted osascript, so a delegated agent cannot reach it and
//   cannot approve on the human's behalf. The detail page is therefore a plain
//   file opened in a browser with no approve control, no form, and no network
//   element. Do NOT "improve" this into an HTTP endpoint, a loopback listener, or
//   a web approve button: any same-user process — including a delegated agent —
//   could reach such a surface, and the property that makes this dialog safe would
//   be gone with no visible signal that it was lost.
// Status: complete

/** One labelled line of decision-relevant context. */
export interface ApprovalField {
  label: string;
  value: string;
}

/** Everything a human needs to decide, independent of how it is presented. */
export interface ApprovalRequest {
  /** Short headline, e.g. "Apply verified patch". */
  title: string;
  /** One-line statement of what approving does. */
  summary: string;
  /** Tool or operation the approval authorizes, e.g. "patch_apply". */
  operation: string;
  /** The concrete thing that changes, e.g. the target repository. */
  target: string;
  /** Truthful classification; never claim reversibility the mesh cannot deliver. */
  reversible: boolean;
  /** How the change is undone, or why it cannot be. */
  reversal?: string;
  /** Ordered detail fields, most decision-relevant first. */
  fields?: readonly ApprovalField[];
  affectedPaths?: readonly string[];
  diffExcerpt?: string;
  evidence?: readonly string[];
  digests?: readonly ApprovalField[];
}

/** Callers with nothing structured to say may still pass one sentence. */
export type ApprovalRequestInput = string | ApprovalRequest;

export type ApprovalChoice = "approve" | "details" | "cancel";

export interface ApprovalDialogInput {
  text: string;
  timeoutMs: number;
  /** False once the detail budget is spent, so the loop cannot be re-entered. */
  offerDetails: boolean;
}

export interface HumanApprovalOptions {
  timeoutMs?: number;
  /** Injected in tests so no window is ever presented. */
  dialog?: (input: ApprovalDialogInput) => Promise<ApprovalChoice>;
  /** Injected in tests so no browser is ever opened. */
  openDetails?: (path: string) => Promise<void>;
  now?: () => number;
}

export interface ApprovalDetailPageMetadata {
  requestedAt: string;
  expiresAt: string;
}

/** A request whose every value is redacted, control-stripped, and bounded. */
export interface NormalizedApprovalRequest {
  readonly title: string;
  readonly summary: string;
  readonly operation: string;
  readonly target: string;
  readonly reversible: boolean;
  readonly reversal: string;
  readonly fields: readonly ApprovalField[];
  readonly affectedPaths: readonly string[];
  readonly diffExcerpt: string | null;
  readonly evidence: readonly string[];
  readonly digests: readonly ApprovalField[];
}

/** The dialog stays readable at this size; the detail page carries the rest. */
export const MAX_DIALOG_CHARACTERS = 3_000;
export const MAX_DIALOG_FIELDS = 10;
export const MAX_DIALOG_VALUE_CHARACTERS = 200;
/** Re-presenting after a detail view is bounded so the loop cannot spin. */
export const MAX_DETAIL_VIEWS = 3;

const MAX_TITLE_CHARACTERS = 120;
const MAX_SUMMARY_CHARACTERS = 600;
const MAX_OPERATION_CHARACTERS = 80;
const MAX_TARGET_CHARACTERS = 600;
const MAX_REVERSAL_CHARACTERS = 600;
const MAX_LABEL_CHARACTERS = 80;
const MAX_FIELD_VALUE_CHARACTERS = 4_000;
const MAX_FIELDS = 40;
const MAX_PATHS = 500;
const MAX_PATH_CHARACTERS = 400;
const MAX_DIFF_CHARACTERS = 64 * 1024;
const MAX_EVIDENCE_ITEMS = 32;
const MAX_EVIDENCE_CHARACTERS = 8_000;
const MAX_DIGESTS = 16;
const MAX_DIGEST_CHARACTERS = 200;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Truncation is always disclosed; a silently cut value misleads the decision. */
function clampText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const removed = value.length - limit;
  return `${value.slice(0, limit)}… [truncated ${plural(removed, "character")}]`;
}

/** Single-line values: every control character, including newlines, becomes space. */
function safeLine(value: unknown, limit: number): string {
  return clampText(
    redactSecrets(String(value ?? ""))
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/ {2,}/g, " ")
      .trim(),
    limit,
  );
}

/** Long-form values keep newlines and tabs; nothing else that can move a cursor. */
function safeBlock(value: unknown, limit: number): string {
  return clampText(
    redactSecrets(String(value ?? ""))
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
      .trimEnd(),
    limit,
  );
}

function boundedList<T, R>(
  values: readonly T[] | undefined,
  limit: number,
  map: (value: T) => R,
  overflow: (count: number) => R,
): R[] {
  const source = values ?? [];
  const shown = source.slice(0, limit).map(map);
  if (source.length > limit) shown.push(overflow(source.length - limit));
  return shown;
}

export function normalizeApprovalRequest(
  input: ApprovalRequestInput,
): NormalizedApprovalRequest {
  const request: ApprovalRequest =
    typeof input === "string"
      ? {
          title: "Agent Mesh approval",
          summary: input,
          operation: "unspecified",
          target: "this machine",
          reversible: false,
          reversal:
            "This request did not declare a reversal path; assume it cannot be undone.",
        }
      : input;
  const summary = safeLine(request.summary, MAX_SUMMARY_CHARACTERS);
  if (!summary) throw new Error("Human approval action must not be empty.");
  const title = safeLine(request.title, MAX_TITLE_CHARACTERS) || "Agent Mesh approval";
  return {
    title,
    summary,
    operation: safeLine(request.operation, MAX_OPERATION_CHARACTERS) || "unspecified",
    target: safeLine(request.target, MAX_TARGET_CHARACTERS) || "unspecified",
    reversible: request.reversible === true,
    reversal: safeLine(request.reversal ?? "", MAX_REVERSAL_CHARACTERS),
    fields: boundedList(
      request.fields,
      MAX_FIELDS,
      (field) => ({
        label: safeLine(field.label, MAX_LABEL_CHARACTERS) || "detail",
        value: safeLine(field.value, MAX_FIELD_VALUE_CHARACTERS),
      }),
      (count) => ({ label: "More", value: `${plural(count, "field")} not shown` }),
    ),
    affectedPaths: boundedList(
      request.affectedPaths,
      MAX_PATHS,
      (path) => safeLine(path, MAX_PATH_CHARACTERS),
      (count) => `[${plural(count, "path")} not shown]`,
    ),
    diffExcerpt: request.diffExcerpt
      ? safeBlock(request.diffExcerpt, MAX_DIFF_CHARACTERS) || null
      : null,
    evidence: boundedList(
      request.evidence,
      MAX_EVIDENCE_ITEMS,
      (item) => safeBlock(item, MAX_EVIDENCE_CHARACTERS),
      (count) => `[${plural(count, "evidence item")} not shown]`,
    ).filter((item) => item.length > 0),
    digests: boundedList(
      request.digests,
      MAX_DIGESTS,
      (digest) => ({
        label: safeLine(digest.label, MAX_LABEL_CHARACTERS) || "digest",
        value: safeLine(digest.value, MAX_DIGEST_CHARACTERS),
      }),
      (count) => ({ label: "More", value: `${plural(count, "digest")} not shown` }),
    ),
  };
}

function reversibilityLine(request: NormalizedApprovalRequest): string {
  const verdict = request.reversible ? "yes" : "NO";
  return `Reversible: ${verdict}${request.reversal ? ` — ${request.reversal}` : ""}`;
}

function longFormSummary(request: NormalizedApprovalRequest): string[] {
  const sections: string[] = [];
  if (request.affectedPaths.length > 0) {
    sections.push(plural(request.affectedPaths.length, "affected path"));
  }
  if (request.diffExcerpt) sections.push("a diff excerpt");
  if (request.evidence.length > 0) {
    sections.push(plural(request.evidence.length, "evidence item"));
  }
  if (request.digests.length > 0) {
    sections.push(plural(request.digests.length, "digest"));
  }
  return sections;
}

/** Build the dialog body from the structured request. */
export function buildApprovalDialogText(input: ApprovalRequestInput): string {
  return dialogTextFor(normalizeApprovalRequest(input));
}

function dialogTextFor(request: NormalizedApprovalRequest): string {
  const lines: string[] = [
    request.title,
    "",
    request.summary,
    "",
    `Operation: ${request.operation}`,
    `Target: ${request.target}`,
    reversibilityLine(request),
  ];
  const shown = request.fields.slice(0, MAX_DIALOG_FIELDS);
  if (shown.length > 0) {
    lines.push("");
    for (const field of shown) {
      lines.push(`${field.label}: ${clampText(field.value, MAX_DIALOG_VALUE_CHARACTERS)}`);
    }
    const hidden = request.fields.length - shown.length;
    if (hidden > 0) {
      lines.push(`[${plural(hidden, "further field")} in the detail page]`);
    }
  }
  const sections = longFormSummary(request);
  if (sections.length > 0) {
    lines.push("", `Detail page also carries ${sections.join(", ")}.`);
  }
  lines.push(
    "",
    "Open details shows a read-only page in your browser. Approval happens only in this dialog.",
  );
  return clampText(lines.join("\n"), MAX_DIALOG_CHARACTERS);
}

/**
 * AppleScript string literals understand \\, \", \n, \r and \t and nothing else,
 * so every one of them is escaped here. A value must never be able to close the
 * literal and become script.
 */
export function escapeAppleScriptString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const DETAIL_PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f6f6f8;
  --panel: #ffffff;
  --fg: #1b1c1f;
  --muted: #5c6068;
  --line: #d9dbe0;
  --ok: #15633a;
  --ok-bg: #e6f4ec;
  --warn: #8a2417;
  --warn-bg: #fbe9e6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a;
    --panel: #1f2125;
    --fg: #e9eaee;
    --muted: #a0a4ad;
    --line: #33363d;
    --ok: #7ddba4;
    --ok-bg: #17301f;
    --warn: #ff9f92;
    --warn-bg: #331a16;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1.25rem 4rem;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
}
main { max-width: 62rem; margin: 0 auto; }
.eyebrow {
  margin: 0 0 .35rem;
  color: var(--muted);
  font-size: .78rem;
  letter-spacing: .09em;
  text-transform: uppercase;
}
h1 { margin: 0 0 .4rem; font-size: 1.65rem; line-height: 1.25; }
h2 {
  margin: 2rem 0 .6rem;
  font-size: .82rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--muted);
}
.summary { margin: 0 0 1.25rem; font-size: 1.05rem; }
.verdict {
  margin: 0 0 1.5rem;
  padding: .85rem 1rem;
  border-radius: 10px;
  border: 1px solid var(--line);
  font-weight: 600;
}
.verdict.ok { color: var(--ok); background: var(--ok-bg); border-color: var(--ok); }
.verdict.warn { color: var(--warn); background: var(--warn-bg); border-color: var(--warn); }
.verdict .note { display: block; margin-top: .3rem; font-weight: 400; color: inherit; }
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: .35rem 1rem;
}
table { width: 100%; border-collapse: collapse; }
th, td { padding: .55rem .25rem; text-align: left; vertical-align: top; }
th {
  width: 15rem;
  font-weight: 600;
  color: var(--muted);
  font-size: .9rem;
}
tr + tr th, tr + tr td { border-top: 1px solid var(--line); }
td { overflow-wrap: anywhere; }
ol.paths, ul.evidence { margin: 0; padding: .5rem 0 .5rem 1.6rem; }
ol.paths li, ul.evidence li { padding: .15rem 0; overflow-wrap: anywhere; }
code, pre, .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, "Courier New", monospace;
  font-size: .86rem;
}
pre.diff {
  margin: 0;
  padding: 1rem;
  overflow-x: auto;
  white-space: pre;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.digest { overflow-wrap: anywhere; }
.muted { color: var(--muted); }
footer {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: .86rem;
}
footer p { margin: .4rem 0; }
`;

function detailRows(fields: readonly ApprovalField[], valueClass = ""): string {
  return fields
    .map(
      (field) =>
        `<tr><th scope="row">${escapeHtml(field.label)}</th>` +
        `<td${valueClass ? ` class="${valueClass}"` : ""}>${
          escapeHtml(field.value) || "<span class=\"muted\">—</span>"
        }</td></tr>`,
    )
    .join("\n");
}

function section(heading: string, body: string): string {
  return `<h2>${escapeHtml(heading)}</h2>\n${body}`;
}

/**
 * Render the read-only detail page. Every interpolated value is HTML-escaped, and
 * the document references nothing outside itself so it renders offline and cannot
 * signal that it was opened.
 */
export function renderApprovalDetailPage(
  input: ApprovalRequestInput,
  metadata: ApprovalDetailPageMetadata,
): string {
  return detailPageFor(normalizeApprovalRequest(input), metadata);
}

function detailPageFor(
  request: NormalizedApprovalRequest,
  metadata: ApprovalDetailPageMetadata,
): string {
  const parts: string[] = [];
  parts.push(
    section(
      "Request",
      `<div class="panel"><table>\n${detailRows([
        { label: "Operation", value: request.operation },
        { label: "Target", value: request.target },
        { label: "Requested at", value: metadata.requestedAt },
        { label: "Approval expires at", value: metadata.expiresAt },
      ])}\n</table></div>`,
    ),
  );
  if (request.fields.length > 0) {
    parts.push(
      section(
        "Details",
        `<div class="panel"><table>\n${detailRows(request.fields)}\n</table></div>`,
      ),
    );
  }
  if (request.affectedPaths.length > 0) {
    parts.push(
      section(
        `Affected paths (${request.affectedPaths.length})`,
        `<div class="panel"><ol class="paths">\n${request.affectedPaths
          .map((path) => `<li><code>${escapeHtml(path)}</code></li>`)
          .join("\n")}\n</ol></div>`,
      ),
    );
  }
  if (request.diffExcerpt) {
    parts.push(
      section("Diff excerpt", `<pre class="diff">${escapeHtml(request.diffExcerpt)}</pre>`),
    );
  }
  if (request.evidence.length > 0) {
    parts.push(
      section(
        "Evidence",
        `<div class="panel"><ul class="evidence">\n${request.evidence
          .map((item) => `<li>${escapeHtml(item).replaceAll("\n", "<br>")}</li>`)
          .join("\n")}\n</ul></div>`,
      ),
    );
  }
  if (request.digests.length > 0) {
    parts.push(
      section(
        "Digests",
        `<div class="panel"><table>\n${detailRows(request.digests, "digest mono")}\n</table></div>`,
      ),
    );
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Mesh approval — ${escapeHtml(request.title)}</title>
<style>${DETAIL_PAGE_STYLE}</style>
</head>
<body>
<main>
<p class="eyebrow">Agent Mesh approval request — read only</p>
<h1>${escapeHtml(request.title)}</h1>
<p class="summary">${escapeHtml(request.summary)}</p>
<p class="verdict ${request.reversible ? "ok" : "warn"}">${
    request.reversible ? "Reversible" : "Not reversible"
  }${
    request.reversal
      ? `<span class="note">${escapeHtml(request.reversal)}</span>`
      : ""
  }</p>
${parts.join("\n")}
<footer>
<p>This page cannot approve anything. It is a local file written with owner-only
permissions and deleted once you decide.</p>
<p>Approve or cancel in the macOS approval dialog, which is the only authorization
surface a delegated agent cannot reach.</p>
</footer>
</main>
</body>
</html>
`;
}

async function writeDetailPage(
  request: NormalizedApprovalRequest,
  metadata: ApprovalDetailPageMetadata,
): Promise<string> {
  const directory = join(stateDirectory(), "approvals");
  await ensurePrivateDirectory(directory);
  const path = join(directory, `${randomUUID()}.html`);
  await writeFile(path, detailPageFor(request, metadata), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
  return path;
}

function dialogScript(input: ApprovalDialogInput, timeoutSeconds: number): string {
  const buttons = input.offerDetails
    ? '{"Cancel", "Open details", "Approve"}'
    : '{"Cancel", "Approve"}';
  return [
    `display dialog "${escapeAppleScriptString(input.text)}"`,
    'with title "Agent Mesh Approval"',
    `buttons ${buttons}`,
    'default button "Cancel"',
    'cancel button "Cancel"',
    "with icon caution",
    `giving up after ${timeoutSeconds}`,
  ].join(" ");
}

async function osascriptDialog(input: ApprovalDialogInput): Promise<ApprovalChoice> {
  const timeoutSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1_000));
  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    ["-e", dialogScript(input, timeoutSeconds)],
    {
      env: buildSafeEnv({ AGENT_MESH_CHILD: "0" }),
      encoding: "utf8",
      timeout: input.timeoutMs + 5_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (/gave up:true/.test(stdout)) return "cancel";
  if (/button returned:Approve/.test(stdout)) return "approve";
  if (/button returned:Open details/.test(stdout)) return "details";
  return "cancel";
}

async function openInDefaultBrowser(path: string): Promise<void> {
  await execFileAsync("/usr/bin/open", [path], {
    env: buildSafeEnv({ AGENT_MESH_CHILD: "0" }),
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
}

export async function requireHumanApproval(
  request: ApprovalRequestInput,
  options: HumanApprovalOptions = {},
): Promise<void> {
  const normalized = normalizeApprovalRequest(request);
  const dialog = options.dialog ?? osascriptDialog;
  const openDetails = options.openDetails ?? openInDefaultBrowser;
  const now = options.now ?? Date.now;
  if (!options.dialog && process.platform !== "darwin") {
    throw new Error("This destructive operation requires an out-of-band human approval UI.");
  }
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 5_000), 300_000);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const metadata: ApprovalDetailPageMetadata = {
    requestedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(deadline).toISOString(),
  };
  const baseText = dialogTextFor(normalized);
  let text = baseText;
  let detailBudget = MAX_DETAIL_VIEWS;
  let detailPage: string | null = null;
  try {
    // Bounded: one initial presentation plus at most MAX_DETAIL_VIEWS re-presentations.
    for (let round = 0; round <= MAX_DETAIL_VIEWS; round += 1) {
      const remainingMs = deadline - now();
      // The deadline stays authoritative: past it the operation fails closed.
      if (remainingMs < 1_000) {
        throw new Error("Human approval was cancelled, timed out, or unavailable.");
      }
      const choice = await dialog({
        text,
        timeoutMs: remainingMs,
        offerDetails: detailBudget > 0,
      });
      if (choice === "approve") return;
      if (choice !== "details" || detailBudget <= 0) break;
      detailBudget -= 1;
      try {
        detailPage ??= await writeDetailPage(normalized, metadata);
        await openDetails(detailPage);
        text = baseText;
      } catch (error) {
        const reason = safeLine(
          error instanceof Error ? error.message : String(error),
          200,
        );
        text = clampText(
          `${baseText}\n\nThe detail page could not be opened: ${reason}`,
          MAX_DIALOG_CHARACTERS,
        );
      }
    }
    throw new Error("Human approval was not granted.");
  } catch (error) {
    if (error instanceof Error && error.message === "Human approval was not granted.") {
      throw error;
    }
    throw new Error("Human approval was cancelled, timed out, or unavailable.");
  } finally {
    // Deleting the detail page is best effort; a leftover file must never fail
    // an approval that the human already answered.
    if (detailPage) await unlink(detailPage).catch(() => undefined);
  }
}
