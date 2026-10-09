import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { waitForPing } from "./mishmash-launch.js";

test("D2: waitForPing stops polling promptly once the child has exited and reports the failure", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  const started = Date.now();
  await assert.rejects(
    waitForPing("fake-node", "http://127.0.0.1:1", () => "LOGS", child),
    /fake-node exited early with code=3/,
  );
  assert.ok(Date.now() - started < 3000, `waitForPing kept polling for ${Date.now() - started}ms`);
});
