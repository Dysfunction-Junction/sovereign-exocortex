import test from "node:test";
import assert from "node:assert/strict";
import { sep, join } from "node:path";
import {
  MESH_NODES,
  DAEMON_NODE_SPEC,
  buildLaunchArgs,
  parseNetstatOutput,
  checkMeshStatus,
  formatStatusTable,
  recordProcess,
  removeProcess,
  emptySupervisorState,
  findServiceSpec,
  type MishmashNodeSpec,
  type ServiceStatus,
} from "./supervisor-core.js";

test("MESH_NODES: contains all 9 mesh services including host daemon", () => {
  assert.equal(MESH_NODES.length, 9, "Expected exactly 9 mesh services");

  const expectedIds = [
    "hermes-api",
    "autonomous-triad",
    "pieces-for-all",
    "agent-mesh-mcp",
    "pattern-analyzer",
    "registry-app",
    "gut-instinct",
    "tool-registry-heartbeat",
    "daemon",
  ];

  for (const id of expectedIds) {
    const found = MESH_NODES.find((s) => s.id === id);
    assert.ok(found, `Service ${id} should be present in MESH_NODES`);
  }

  assert.equal(DAEMON_NODE_SPEC.id, "daemon");
  assert.equal(DAEMON_NODE_SPEC.port, 8788);
  assert.equal(DAEMON_NODE_SPEC.runner, "tsx");
  assert.equal(DAEMON_NODE_SPEC.script, "apps/daemon/src/server.ts");
  assert.equal(DAEMON_NODE_SPEC.portVariable, "GATEWAY_PORT");
});

test("buildLaunchArgs: pure argument building for Python runner", () => {
  const triadSpec: MishmashNodeSpec = {
    id: "autonomous-triad",
    role: "intent and review",
    port: 8789,
    envKey: "TRIAD_UPSTREAM",
    repo: "autonomous-triad",
    runner: "python",
    script: "triad.server",
    portVariable: "TRIAD_PORT",
  };

  const launch = buildLaunchArgs(triadSpec, {
    reposRoot: "C:\\mock\\projects",
    pythonBin: "C:\\mock\\projects\\autonomous-triad\\.venv\\Scripts\\python.exe",
  });

  assert.equal(launch.command, "C:\\mock\\projects\\autonomous-triad\\.venv\\Scripts\\python.exe");
  assert.deepEqual(launch.args, ["-m", "triad.server"]);
  assert.equal(launch.cwd, `C:\\mock\\projects${sep}autonomous-triad`);
  assert.equal(launch.env.TRIAD_PORT, "8789");
  assert.equal(launch.env.PYTHONUNBUFFERED, "1");
});

test("buildLaunchArgs: pure argument building for tsx runner with path normalization", () => {
  const hermesSpec: MishmashNodeSpec = {
    id: "hermes-api",
    role: "device and phone tasks",
    port: 3000,
    envKey: "HERMES_UPSTREAM",
    repo: "hermes-api",
    runner: "tsx",
    script: "mishmash/delegate.ts",
    portVariable: "MISHMASH_PORT",
  };

  const launch = buildLaunchArgs(hermesSpec, {
    reposRoot: "C:\\mock\\projects",
    tsxPath: "C:\\mock\\tsx\\cli.mjs",
    nodeBin: "node.exe",
  });

  assert.equal(launch.command, "node.exe");
  assert.equal(launch.args[0], "C:\\mock\\tsx\\cli.mjs");
  const expectedScript = `mishmash${sep}delegate.ts`;
  assert.equal(launch.args[1], expectedScript);
  assert.equal(launch.cwd, `C:\\mock\\projects${sep}hermes-api`);
  assert.equal(launch.env.MISHMASH_PORT, "3000");
  assert.equal(launch.env.PORT, "3000");
});

test("buildLaunchArgs: pure argument building for node runner", () => {
  const gutSpec: MishmashNodeSpec = {
    id: "gut-instinct",
    role: "on-device coach contract",
    port: 39404,
    envKey: "GUT_INSTINCT_UPSTREAM",
    repo: "gut-instinct",
    runner: "node",
    script: "mishmash/delegate.mjs",
    portVariable: "MISHMASH_PORT",
  };

  const launch = buildLaunchArgs(gutSpec, {
    reposRoot: "C:\\mock\\projects",
    nodeBin: "node.exe",
  });

  assert.equal(launch.command, "node.exe");
  const expectedScript = `mishmash${sep}delegate.mjs`;
  assert.equal(launch.args[0], expectedScript);
  assert.equal(launch.cwd, `C:\\mock\\projects${sep}gut-instinct`);
  assert.equal(launch.env.MISHMASH_PORT, "39404");
});

test("buildLaunchArgs: daemon node resolves correctly under sovereign-exocortex", () => {
  const launch = buildLaunchArgs(DAEMON_NODE_SPEC, {
    reposRoot: "C:\\mock\\projects",
    tsxPath: "C:\\mock\\tsx\\cli.mjs",
    nodeBin: "node.exe",
  });

  assert.equal(launch.command, "node.exe");
  const expectedScript = join("apps", "daemon", "src", "server.ts");
  assert.equal(launch.args[1], expectedScript);
  assert.equal(launch.cwd, `C:\\mock\\projects${sep}sovereign-exocortex`);
  assert.equal(launch.env.GATEWAY_PORT, "8788");
});

test("parseNetstatOutput: accurately parses listening TCP ports and PIDs", () => {
  const mockNetstat = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044
  TCP    0.0.0.0:8788           0.0.0.0:0              LISTENING       38212
  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       21968
  TCP    127.0.0.1:3000         127.0.0.1:51421        ESTABLISHED     21968
  TCP    [::]:8789              [::]:0                 LISTENING       30576
  TCP    [::]:39400             [::]:0                 LISTENING       35152
  TCP    127.0.0.1:54321        127.0.0.1:8788        TIME_WAIT       0
`;

  const map = parseNetstatOutput(mockNetstat);
  assert.equal(map.get(135), 1044);
  assert.equal(map.get(8788), 38212);
  assert.equal(map.get(3000), 21968);
  assert.equal(map.get(8789), 30576);
  assert.equal(map.get(39400), 35152);
  assert.equal(map.get(54321), undefined, "TIME_WAIT must not be parsed as listening");
});

test("checkMeshStatus: pure evaluation with mock probe and PID mapper", async () => {
  const sampleNodes: MishmashNodeSpec[] = [
    {
      id: "node-a",
      role: "role a",
      port: 1001,
      envKey: "A",
      repo: "repo-a",
      runner: "node",
      script: "a.js",
      portVariable: "PORT",
    },
    {
      id: "node-b",
      role: "role b",
      port: 1002,
      envKey: "B",
      repo: "repo-b",
      runner: "node",
      script: "b.js",
      portVariable: "PORT",
    },
  ];

  // node-a is listening with PID 9999, managed by supervisor.
  // node-b is down.
  const mockProbe = async (port: number) => port === 1001;
  const mockLookup = (port: number) => (port === 1001 ? 9999 : null);
  const supervisorPids = new Set([9999]);

  const statuses = await checkMeshStatus(sampleNodes, {
    probe: mockProbe,
    pidLookup: mockLookup,
    supervisorPids,
  });

  assert.equal(statuses.length, 2);
  assert.deepEqual(statuses[0], {
    id: "node-a",
    role: "role a",
    port: 1001,
    status: "UP",
    pid: 9999,
    startedBySupervisor: true,
  });
  assert.deepEqual(statuses[1], {
    id: "node-b",
    role: "role b",
    port: 1002,
    status: "DOWN",
    pid: null,
    startedBySupervisor: false,
  });
});

test("formatStatusTable: produces formatted output with column headers", () => {
  const mockStatuses: ServiceStatus[] = [
    {
      id: "hermes-api",
      role: "device and phone tasks",
      port: 3000,
      status: "UP",
      pid: 21968,
      startedBySupervisor: false,
    },
    {
      id: "autonomous-triad",
      role: "intent and review",
      port: 8789,
      status: "DOWN",
      pid: null,
      startedBySupervisor: false,
    },
  ];

  const table = formatStatusTable(mockStatuses);
  assert.ok(table.includes("SERVICE"));
  assert.ok(table.includes("PORT"));
  assert.ok(table.includes("STATUS"));
  assert.ok(table.includes("PID"));
  assert.ok(table.includes("MANAGED"));
  assert.ok(table.includes("hermes-api"));
  assert.ok(table.includes("3000"));
  assert.ok(table.includes("UP"));
  assert.ok(table.includes("external"));
  assert.ok(table.includes("autonomous-triad"));
  assert.ok(table.includes("DOWN"));
});

test("SupervisorState: tracking and removing started processes cleanly", () => {
  let state = emptySupervisorState();
  assert.equal(state.version, 1);
  assert.deepEqual(state.processes, {});

  state = recordProcess(state, "hermes-api", 12345, 3000, "2026-10-25T12:00:00Z");
  assert.deepEqual(state.processes["hermes-api"], {
    pid: 12345,
    port: 3000,
    startedAt: "2026-10-25T12:00:00Z",
  });

  state = recordProcess(state, "daemon", 67890, 8788, "2026-10-25T12:01:00Z");
  assert.equal(Object.keys(state.processes).length, 2);

  state = removeProcess(state, "hermes-api");
  assert.equal(state.processes["hermes-api"], undefined);
  assert.ok(state.processes["daemon"]);
  assert.equal(Object.keys(state.processes).length, 1);
});

test("findServiceSpec: resolves exact IDs and supported aliases", () => {
  assert.equal(findServiceSpec("hermes-api")?.id, "hermes-api");
  assert.equal(findServiceSpec("HERMES-API")?.id, "hermes-api");
  assert.equal(findServiceSpec("daemon")?.id, "daemon");
  assert.equal(findServiceSpec("exocortexd")?.id, "daemon");
  assert.equal(findServiceSpec("exocortex-daemon")?.id, "daemon");
  assert.equal(findServiceSpec("sovereign-exocortex")?.id, "daemon");
  assert.equal(findServiceSpec("gut-instinct")?.id, "gut-instinct");
  assert.equal(findServiceSpec("gutinstinct")?.id, "gut-instinct");
  assert.equal(findServiceSpec("autonomous-triad")?.id, "autonomous-triad");
  assert.equal(findServiceSpec("triad")?.id, "autonomous-triad");
  assert.equal(findServiceSpec("nonexistent"), undefined);
});
