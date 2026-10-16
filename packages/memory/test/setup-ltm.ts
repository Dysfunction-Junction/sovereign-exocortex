// Import this FIRST in any test that reaches the gateway's memory.add. The
// `localLTM` singleton resolves its file once, at import time, so the env var has
// to be set before ../server.js is evaluated. ES imports evaluate in order,
// which is why this is a side-effect module rather than a call in the test body.
//
// Without it, memory.add writes to the tracked data/memories.jsonl and every test
// run leaves a new junk entry in the working tree.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.LOCAL_LTM_FILE || process.env.LOCAL_LTM_FILE.trim() === "") {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-test-ltm-"));
  process.env.LOCAL_LTM_FILE = join(dir, "memories.jsonl");
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });
}
