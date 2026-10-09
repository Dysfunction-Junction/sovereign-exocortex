import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildSafeEnv } from "./security.js";
import type { ApprovalChoice, ApprovalDialogInput } from "./human-approval.js";

// Windows approval surface: Windows Hello (UserConsentVerifier).
//
// Why Windows Hello and not a message box: the macOS dialog is safe because a delegated agent cannot
// reach or click it. A plain Windows message box can be driven by any same-user process. The Hello
// prompt runs in the credential UI and needs a fingerprint, face or PIN from the person at the PC, so
// a same-user process can start the prompt but cannot answer it.
//
// Trust boundary (same rule as the macOS dialog): authorization stays in this out-of-band prompt. The
// detail page is a read-only file with no approve control. Do NOT replace this with an HTTP endpoint,
// a loopback listener or a web approve button.
//
// Limits: the Hello prompt shows a short message only, so the full request (digests, paths, evidence)
// is shown on the detail page, which the Windows flow opens BEFORE the prompt.

const execFileAsync = promisify(execFile);

const RESULT_PREFIX = "EXO_HELLO:";

/** Longest message handed to the Hello prompt; the credential UI truncates long text. */
export const HELLO_MESSAGE_MAX_CHARACTERS = 200;

/** Windows PowerShell 5.1 only: PowerShell 7 (.NET 5+) no longer projects WinRT types. */
export const HELLO_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]",
  "  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  "  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }",
  "  $avail = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])",
  `  if ("$avail" -ne 'Available') { Write-Output "${RESULT_PREFIX}Unavailable:$avail"; exit 0 }`,
  "  $res = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($env:EXO_APPROVAL_MESSAGE)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])",
  `  Write-Output "${RESULT_PREFIX}Result:$res"`,
  "} catch {",
  `  Write-Output "${RESULT_PREFIX}Error"`,
  "}",
].join("\n");

/** Raised when Hello cannot be used at all (not set up, no device). Never treated as an approval. */
export class WindowsHelloUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Windows Hello is unavailable (${reason}). Set up a PIN, fingerprint or face in Windows Settings.`);
    this.name = "WindowsHelloUnavailableError";
  }
}

/**
 * Collapse the dialog text to a short single message. Control characters and anything that could be
 * read as markup are removed; the full request lives on the detail page.
 */
export function helloMessageFor(text: string): string {
  const flat = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const prefix = "Agent Mesh approval: ";
  const room = HELLO_MESSAGE_MAX_CHARACTERS - prefix.length;
  const body = flat.length > room ? `${flat.slice(0, Math.max(0, room - 1))}…` : flat;
  return `${prefix}${body}`;
}

/**
 * Only an exact "Verified" result approves. Every other value (Canceled, RetriesExhausted, DeviceBusy,
 * garbage, extra lines, missing output) is a cancel, and "Unavailable" is surfaced as an error.
 */
export function parseHelloOutput(stdout: string): ApprovalChoice {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(RESULT_PREFIX));
  if (lines.length !== 1) return "cancel";
  const line = lines[0]!;
  const unavailable = /^EXO_HELLO:Unavailable:([A-Za-z]{1,40})$/.exec(line);
  if (unavailable) throw new WindowsHelloUnavailableError(unavailable[1]!);
  return line === `${RESULT_PREFIX}Result:Verified` ? "approve" : "cancel";
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export type HelloExec = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; windowsHide: boolean; encoding: "utf8" },
) => Promise<{ stdout: string }>;

/** Dialog implementation for ApprovalDialogInput. `exec` is injectable so tests never open a prompt. */
export function createWindowsHelloDialog(exec: HelloExec = execFileAsync as unknown as HelloExec) {
  return async function windowsHelloDialog(input: ApprovalDialogInput): Promise<ApprovalChoice> {
    const { stdout } = await exec(
      windowsPowerShellPath(),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(HELLO_SCRIPT)],
      {
        // The message travels in the environment, never inside the script text.
        env: buildSafeEnv({ AGENT_MESH_CHILD: "0", EXO_APPROVAL_MESSAGE: helloMessageFor(input.text) }),
        encoding: "utf8",
        timeout: input.timeoutMs + 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    );
    return parseHelloOutput(stdout);
  };
}

export const windowsHelloDialog = createWindowsHelloDialog();

/** Opens the read-only detail page with the default handler; argv form, so no shell parsing of the path. */
export async function openInDefaultBrowserWindows(path: string, exec: HelloExec = execFileAsync as unknown as HelloExec): Promise<void> {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  await exec(join(root, "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", path], {
    env: buildSafeEnv({ AGENT_MESH_CHILD: "0" }),
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
}
