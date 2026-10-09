#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const targetPgid = Number(process.argv[2]);
const supervisorPid = Number(process.argv[3]);
if (
  !Number.isInteger(targetPgid) ||
  targetPgid <= 1 ||
  !Number.isInteger(supervisorPid) ||
  supervisorPid <= 1
) {
  process.exit(127);
}

const groupMembers = () => {
  const result = spawnSync("ps", ["-axo", "pid=,pgid="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => Number.isInteger(pid) && pgid === targetPgid)
    .map(([pid]) => pid);
};

const delay = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

let quietPasses = 0;
for (let attempt = 0; attempt < 100; attempt += 1) {
  const members = groupMembers().filter((pid) => pid !== supervisorPid);
  for (const pid of members) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
  if (members.length === 0) quietPasses += 1;
  else quietPasses = 0;
  if (quietPasses >= 3) {
    try {
      process.kill(supervisorPid, "SIGUSR1");
      process.exit(0);
    } catch {
      process.exit(0);
    }
  }
  await delay(50);
}

try {
  process.kill(-targetPgid, "SIGKILL");
} catch {
  // Group already exited.
}
process.exit(1);
