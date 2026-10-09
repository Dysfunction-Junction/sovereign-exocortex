#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const reaperPath = fileURLToPath(new URL("./reap-group.mjs", import.meta.url));

const raw = process.env.AGENT_MESH_SUPERVISED_PROCESS;
const ownerPid = Number(process.env.AGENT_MESH_OWNER_PID);
if (!raw || !Number.isInteger(ownerPid) || ownerPid <= 1) {
  process.stderr.write("agent-mesh supervisor: invalid launch metadata\n");
  process.exit(127);
}

let spec;
try {
  spec = JSON.parse(raw);
} catch {
  process.stderr.write("agent-mesh supervisor: invalid process specification\n");
  process.exit(127);
}
if (
  !spec ||
  typeof spec.command !== "string" ||
  !Array.isArray(spec.args) ||
  !spec.args.every((arg) => typeof arg === "string")
) {
  process.stderr.write("agent-mesh supervisor: invalid command specification\n");
  process.exit(127);
}

const env = { ...process.env };
delete env.AGENT_MESH_SUPERVISED_PROCESS;
delete env.AGENT_MESH_OWNER_PID;

const child = spawn(spec.command, spec.args, {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
  shell: false,
  detached: false,
});

let terminating = false;
let desiredExitCode = 1;

const terminateGroup = (signal, exitCode = 1) => {
  if (terminating) return;
  terminating = true;
  desiredExitCode = exitCode;
  try {
    process.kill(-process.pid, signal);
  } catch {
    child.kill(signal);
  }
  const reaper = spawn(
    process.execPath,
    [reaperPath, String(process.pid), String(process.pid)],
    {
      detached: true,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
    },
  );
  reaper.once("error", () => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  });
  reaper.unref();
};

process.on("SIGINT", () => terminateGroup("SIGINT"));
process.on("SIGTERM", () => terminateGroup("SIGTERM"));
process.on("SIGUSR1", () => process.exit(desiredExitCode));

const ownerMonitor = setInterval(() => {
  try {
    process.kill(ownerPid, 0);
  } catch {
    terminateGroup("SIGTERM");
  }
}, 500);
ownerMonitor.unref();

child.once("error", (error) => {
  process.stderr.write(`agent-mesh supervisor: ${error.message}\n`);
  process.exit(127);
});
child.once("exit", (code, signal) => {
  clearInterval(ownerMonitor);
  terminateGroup("SIGTERM", signal ? 1 : (code ?? 1));
});
