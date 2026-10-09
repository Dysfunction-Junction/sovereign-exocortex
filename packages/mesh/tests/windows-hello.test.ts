import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { requireHumanApproval, type ApprovalChoice } from "../src/human-approval.js";
import {
  HELLO_MESSAGE_MAX_CHARACTERS,
  HELLO_SCRIPT,
  WindowsHelloUnavailableError,
  createWindowsHelloDialog,
  encodePowerShell,
  helloMessageFor,
  parseHelloOutput,
  windowsPowerShellPath,
  type HelloExec,
} from "../src/windows-hello.js";

const request = {
  title: "Apply verified patch",
  summary: "Writes the verified patch into the target repository.",
  operation: "patch_apply",
  target: "C:\\repo",
  reversible: true,
  reversal: "patch_rollback restores the previous tree.",
  digests: [{ label: "Patch SHA-256", value: "a".repeat(64) }],
};

describe("Windows Hello approval", () => {
  const originalStateDir = process.env.AGENT_MESH_STATE_DIR;
  const directories: string[] = [];

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.AGENT_MESH_STATE_DIR;
    else process.env.AGENT_MESH_STATE_DIR = originalStateDir;
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function privateStateDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "mesh-hello-"));
    directories.push(directory);
    process.env.AGENT_MESH_STATE_DIR = directory;
    return directory;
  }

  it("approves only on an exact Verified result", () => {
    expect(parseHelloOutput("EXO_HELLO:Result:Verified\r\n")).toBe("approve");
    for (const out of [
      "EXO_HELLO:Result:Canceled",
      "EXO_HELLO:Result:RetriesExhausted",
      "EXO_HELLO:Result:DeviceBusy",
      "EXO_HELLO:Result:verified",
      "EXO_HELLO:Result:Verified extra",
      "EXO_HELLO:Error",
      "",
      "Verified",
      // two result lines (e.g. injected output) never approve
      "EXO_HELLO:Result:Verified\nEXO_HELLO:Result:Verified",
      "EXO_HELLO:Result:Canceled\nEXO_HELLO:Result:Verified",
    ]) {
      expect(parseHelloOutput(out)).toBe("cancel");
    }
  });

  it("surfaces an unavailable Hello as an error, never as an approval", () => {
    expect(() => parseHelloOutput("EXO_HELLO:Unavailable:NotConfiguredForUser")).toThrow(
      WindowsHelloUnavailableError,
    );
    expect(() => parseHelloOutput("EXO_HELLO:Unavailable:DeviceNotPresent")).toThrow(/DeviceNotPresent/);
  });

  it("passes the message through the environment, not the script text", async () => {
    let seen: { file: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number } | undefined;
    const exec: HelloExec = async (file, args, options) => {
      seen = { file, args, env: options.env, timeout: options.timeout };
      return { stdout: "EXO_HELLO:Result:Verified\n" };
    };
    const hostile = `Apply "patch"'; Remove-Item -Recurse C:\\ ; $(whoami) \`n`;
    const choice = await createWindowsHelloDialog(exec)({ text: hostile, timeoutMs: 30_000, offerDetails: false });
    expect(choice).toBe("approve");
    expect(seen?.file).toBe(windowsPowerShellPath());
    expect(seen?.file.toLowerCase()).toContain("windowspowershell");
    expect(seen?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(seen?.args[3]).toBe(encodePowerShell(HELLO_SCRIPT));
    // the hostile text appears only in the environment variable
    expect(Buffer.from(seen!.args[3]!, "base64").toString("utf16le")).not.toContain("Remove-Item");
    expect(seen?.env.EXO_APPROVAL_MESSAGE).toContain("Remove-Item");
    expect(seen?.timeout).toBe(35_000);
    expect(HELLO_SCRIPT).toContain("$env:EXO_APPROVAL_MESSAGE");
  });

  it("keeps the Hello message short, single-line and control-character free", () => {
    const message = helloMessageFor(`Line one\nLine two\u0000\u001b[31m ${"x".repeat(500)}`);
    expect(message.length).toBeLessThanOrEqual(HELLO_MESSAGE_MAX_CHARACTERS);
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(message.startsWith("Agent Mesh approval: ")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
    expect(helloMessageFor("short")).toBe("Agent Mesh approval: short");
  });

  it("a failed or cancelled Hello prompt never approves", async () => {
    const cancel = createWindowsHelloDialog(async () => ({ stdout: "EXO_HELLO:Result:Canceled" }));
    await expect(
      requireHumanApproval(request, { platform: "win32", dialog: cancel, openDetails: async () => undefined }),
    ).rejects.toThrow("Human approval was not granted.");
    const boom = createWindowsHelloDialog(async () => {
      throw new Error("powershell crashed");
    });
    await expect(
      requireHumanApproval(request, { platform: "win32", dialog: boom, openDetails: async () => undefined }),
    ).rejects.toThrow("Human approval was cancelled, timed out, or unavailable.");
  });

  it("reports an unavailable Hello with a clear reason", async () => {
    privateStateDirectory();
    const unavailable = createWindowsHelloDialog(async () => ({
      stdout: "EXO_HELLO:Unavailable:NotConfiguredForUser",
    }));
    await expect(
      requireHumanApproval(request, { platform: "win32", dialog: unavailable, openDetails: async () => undefined }),
    ).rejects.toThrow(/Windows Hello is unavailable \(NotConfiguredForUser\)/);
  });

  it("opens the detail page BEFORE the Hello prompt and never offers a details button", async () => {
    privateStateDirectory();
    const order: string[] = [];
    const offered: boolean[] = [];
    await requireHumanApproval(request, {
      platform: "win32",
      presentDetailsFirst: true,
      openDetails: async () => {
        order.push("details");
      },
      dialog: async (input): Promise<ApprovalChoice> => {
        order.push("prompt");
        offered.push(input.offerDetails);
        return "approve";
      },
    });
    expect(order).toEqual(["details", "prompt"]);
    expect(offered).toEqual([false]);
  });

  it("fails closed on Windows when the detail page cannot be opened", async () => {
    privateStateDirectory();
    let prompted = false;
    await expect(
      requireHumanApproval(request, {
        platform: "win32",
        presentDetailsFirst: true,
        openDetails: async () => {
          throw new Error("no default browser");
        },
        dialog: async () => {
          prompted = true;
          return "approve";
        },
      }),
    ).rejects.toThrow("Human approval was cancelled, timed out, or unavailable.");
    expect(prompted).toBe(false);
  });

  it("still refuses on platforms with no approval surface", async () => {
    await expect(requireHumanApproval(request, { platform: "linux" })).rejects.toThrow(
      "requires an out-of-band human approval UI",
    );
  });

  it("macOS flow is unchanged: details are offered through the dialog, not opened first", async () => {
    privateStateDirectory();
    const opened: string[] = [];
    const offered: boolean[] = [];
    const choices: ApprovalChoice[] = ["details", "approve"];
    await requireHumanApproval(request, {
      platform: "darwin",
      openDetails: async (path) => {
        opened.push(path);
      },
      dialog: async (input) => {
        offered.push(input.offerDetails);
        return choices.shift() ?? "cancel";
      },
    });
    expect(opened).toHaveLength(1);
    expect(offered).toEqual([true, true]);
  });
});
