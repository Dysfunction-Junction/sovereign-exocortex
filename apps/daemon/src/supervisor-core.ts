/**
 * @file supervisor-core.ts
 * Core logic for the 9-service Sovereign Exocortex local mesh process supervisor.
 *
 * ARCHITECTURAL DESIGN & CONVENTIONS:
 * 1. 9-Service Local Mesh Source of Truth:
 *    The 8 upstream nodes are imported from mishmash-nodes.ts (hermes-api, autonomous-triad,
 *    pieces-for-all, agent-mesh-mcp, pattern-analyzer, registry-app, gut-instinct, tool-registry-heartbeat),
 *    and combined with the 9th service: this repo's host daemon (port 8788, apps/daemon/src/server.ts).
 *
 * 2. Pure Functions for High-Assurance Testability:
 *    Process argument building, netstat PID parsing, port probing, table formatting, and PID state
 *    management are implemented as deterministic, dependency-injectable pure functions. This allows
 *    comprehensive unit testing without spawning OS processes or binding network sockets.
 *
 * 3. Windows Native Process Environment:
 *    All path resolutions use Windows backslashes (\). Runners are mapped appropriately:
 *    - python: uses local .venv\Scripts\python.exe if present, else MISHMASH_PYTHON or system python
 *    - tsx: uses resolved tsx cli or npm-bundled binary
 *    - node: uses process.execPath
 *    Process tree termination on Windows uses taskkill /pid <PID> /T [/F] to avoid orphan children.
 *
 * 4. Safe State Management:
 *    Only processes launched by this supervisor are tracked in the persistent state file
 *    (.supervisor-pids.json). The `stop` action cleanly halts only supervisor-spawned processes,
 *    leaving pre-existing or externally managed services intact.
 *
 * 5. Scope Boundary:
 *    This first pass supports start/status/stop/restart. Auto-restart watchdog loops are explicitly
 *    deferred per architectural direction.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from "node:fs";
import { Socket } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MISHMASH_LAUNCH, type MishmashNodeSpec } from "./mishmash-nodes.js";

export { type MishmashNodeSpec };

/**
 * Specification for the 9th mesh service: Sovereign Exocortex host daemon.
 */
export const DAEMON_NODE_SPEC: MishmashNodeSpec = {
  id: "daemon",
  role: "exocortex daemon gateway & event orchestrator",
  port: 8788,
  envKey: "DAEMON_UPSTREAM",
  repo: "sovereign-exocortex",
  runner: "tsx",
  script: "apps/daemon/src/server.ts",
  portVariable: "GATEWAY_PORT",
};

/**
 * The complete 9-service local mesh specification list.
 */
export const MESH_NODES: MishmashNodeSpec[] = [
  ...MISHMASH_LAUNCH,
  DAEMON_NODE_SPEC,
];

/**
 * Finds the directory containing sibling project checkouts by walking up candidate roots.
 */
export function findReposRoot(startDir?: string): string {
  const starts: string[] = [];
  if (startDir) starts.push(resolve(startDir));
  try {
    starts.push(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // ignore in environments where import.meta.url is not standard
  }
  starts.push(process.cwd());

  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      const hasHermes = existsSync(join(dir, "hermes-api"));
      const hasTriad = existsSync(join(dir, "autonomous-triad"));
      const hasExocortex = existsSync(join(dir, "sovereign-exocortex")) || existsSync(join(dir, "pieces-for-all"));
      if (hasHermes && hasTriad && hasExocortex) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(process.cwd(), "../../..");
}

/**
 * Resolves tsx CLI path on Windows.
 */
export function findTsxCli(reposRoot?: string): string | null {
  if (process.env.MISHMASH_TSX && existsSync(process.env.MISHMASH_TSX)) {
    return process.env.MISHMASH_TSX;
  }
  const root = reposRoot ?? findReposRoot();
  const candidates = [
    join(root, "sovereign-exocortex", "apps", "daemon", "node_modules", "tsx", "dist", "cli.mjs"),
    join(root, "sovereign-exocortex", "node_modules", "tsx", "dist", "cli.mjs"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface LaunchConfig {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Pure function: Builds OS launch command, arguments, working directory, and environment variables.
 */
export function buildLaunchArgs(
  spec: MishmashNodeSpec,
  options: {
    reposRoot: string;
    tsxPath?: string | null;
    pythonBin?: string;
    nodeBin?: string;
    extraEnv?: Record<string, string>;
  }
): LaunchConfig {
  const cwd = join(options.reposRoot, spec.repo);
  const nodeBin = options.nodeBin ?? process.execPath;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.extraEnv ?? {}),
    [spec.portVariable]: String(spec.port),
    PORT: String(spec.port),
  };

  if (spec.runner === "python") {
    let pythonBin = options.pythonBin;
    if (!pythonBin) {
      const winVenv = join(cwd, ".venv", "Scripts", "python.exe");
      const nixVenv = join(cwd, ".venv", "bin", "python");
      if (process.platform === "win32" && existsSync(winVenv)) {
        pythonBin = winVenv;
      } else if (existsSync(nixVenv)) {
        pythonBin = nixVenv;
      } else {
        pythonBin = process.platform === "win32" ? "python" : "python3";
      }
    }
    env.PYTHONUNBUFFERED = "1";
    return {
      command: pythonBin,
      args: ["-m", spec.script],
      cwd,
      env,
    };
  }

  // Normalize script path with OS separator (backslashes on Windows)
  const scriptNormalized = spec.script.includes("/") ? spec.script.split("/").join(sep) : spec.script;

  if (spec.runner === "tsx") {
    const tsx = options.tsxPath ?? "tsx";
    if (tsx.endsWith(".mjs") || tsx.endsWith(".js") || tsx.endsWith(".cjs")) {
      return {
        command: nodeBin,
        args: [tsx, scriptNormalized],
        cwd,
        env,
      };
    }
    return {
      command: tsx,
      args: [scriptNormalized],
      cwd,
      env,
    };
  }

  // runner === "node"
  return {
    command: nodeBin,
    args: [scriptNormalized],
    cwd,
    env,
  };
}

/**
 * Pure function: Parses Windows `netstat -ano -p tcp` output into a map of Port -> Owning PID.
 */
export function parseNetstatOutput(output: string): Map<number, number> {
  const portToPid = new Map<number, number>();
  const lines = output.split(/\r?\n/);
  // TCP    0.0.0.0:8788           0.0.0.0:0              LISTENING       38212
  // TCP    [::]:8788              [::]:0                 LISTENING       38212
  // TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       21968
  const regex = /^\s*TCP\s+(?:\[[\da-fA-F:]+\]|[\d\.]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i;
  for (const line of lines) {
    const match = regex.exec(line);
    if (match) {
      const port = Number.parseInt(match[1]!, 10);
      const pid = Number.parseInt(match[2]!, 10);
      if (!Number.isNaN(port) && !Number.isNaN(pid) && !portToPid.has(port)) {
        portToPid.set(port, pid);
      }
    }
  }
  return portToPid;
}

export type PortProbe = (port: number, host?: string, timeoutMs?: number) => Promise<boolean>;

/**
 * Socket-based TCP probe: attempts connection to 127.0.0.1:<port>.
 */
export function defaultProbePort(port: number, host = "127.0.0.1", timeoutMs = 800): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = new Socket();
    let settled = false;
    const finish = (result: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolveProbe(result);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export interface ServiceStatus {
  id: string;
  role: string;
  port: number;
  status: "UP" | "DOWN";
  pid: number | null;
  startedBySupervisor: boolean;
}

/**
 * Pure function: Evaluates health and PID status for a list of service specifications.
 */
export async function checkMeshStatus(
  nodes: MishmashNodeSpec[],
  options: {
    probe?: PortProbe;
    pidLookup?: (port: number) => number | null;
    supervisorPids?: Set<number>;
  } = {}
): Promise<ServiceStatus[]> {
  const probe = options.probe ?? defaultProbePort;
  return Promise.all(
    nodes.map(async (spec) => {
      const isUp = await probe(spec.port);
      const pid = options.pidLookup ? options.pidLookup(spec.port) : null;
      const startedBySupervisor = pid !== null && (options.supervisorPids?.has(pid) ?? false);
      return {
        id: spec.id,
        role: spec.role,
        port: spec.port,
        status: isUp ? "UP" : "DOWN",
        pid: isUp ? pid : null,
        startedBySupervisor,
      };
    })
  );
}

/**
 * Pure function: Formats an ASCII table of service statuses for CLI display.
 */
export function formatStatusTable(statuses: ServiceStatus[]): string {
  const headers = ["SERVICE", "PORT", "STATUS", "PID", "MANAGED", "ROLE"];
  const rows = statuses.map((s) => [
    s.id,
    String(s.port),
    s.status,
    s.pid ? String(s.pid) : "-",
    s.startedBySupervisor ? "supervisor" : s.status === "UP" ? "external" : "-",
    s.role,
  ]);

  const colWidths = headers.map((header, idx) => {
    const maxRowWidth = rows.reduce((max, row) => Math.max(max, row[idx]?.length ?? 0), 0);
    return Math.max(header.length, maxRowWidth);
  });

  const pad = (str: string, width: number, alignRight = false) => {
    if (alignRight) return str.padStart(width, " ");
    return str.padEnd(width, " ");
  };

  const separator = `+${colWidths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const headerLine = `| ${headers.map((h, i) => pad(h, colWidths[i]!)).join(" | ")} |`;
  const dataLines = rows.map((row) => {
    return `| ${row.map((cell, i) => pad(cell, colWidths[i]!, i === 1 || i === 3)).join(" | ")} |`;
  });

  return [separator, headerLine, separator, ...dataLines, separator].join("\n");
}

export interface TrackedProcess {
  pid: number;
  port: number;
  startedAt: string;
}

export interface SupervisorState {
  version: 1;
  processes: Record<string, TrackedProcess>;
}

export function emptySupervisorState(): SupervisorState {
  return { version: 1, processes: {} };
}

export function recordProcess(
  state: SupervisorState,
  id: string,
  pid: number,
  port: number,
  startedAt?: string
): SupervisorState {
  return {
    ...state,
    processes: {
      ...state.processes,
      [id]: { pid, port, startedAt: startedAt ?? new Date().toISOString() },
    },
  };
}

export function removeProcess(state: SupervisorState, id: string): SupervisorState {
  const next = { ...state.processes };
  delete next[id];
  return {
    ...state,
    processes: next,
  };
}

export function loadSupervisorState(filePath: string): SupervisorState {
  try {
    if (!existsSync(filePath)) return emptySupervisorState();
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as SupervisorState;
    if (parsed && typeof parsed.processes === "object") {
      return parsed;
    }
  } catch {
    // Return empty state on corrupted or inaccessible state file
  }
  return emptySupervisorState();
}

export function saveSupervisorState(filePath: string, state: SupervisorState): void {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error(`Failed to save supervisor state to ${filePath}:`, err);
  }
}

/**
 * Pure function: Resolves a service specification by exact ID or known alias.
 */
export function findServiceSpec(idOrAlias: string, nodes: MishmashNodeSpec[] = MESH_NODES): MishmashNodeSpec | undefined {
  const target = idOrAlias.trim().toLowerCase();
  return nodes.find((s) => {
    const sid = s.id.toLowerCase();
    if (sid === target) return true;
    if (
      sid === "daemon" &&
      (target === "exocortexd" || target === "exocortex-daemon" || target === "sovereign-exocortex" || target === "gateway")
    ) {
      return true;
    }
    if (sid === "gut-instinct" && target === "gutinstinct") return true;
    if (sid === "autonomous-triad" && target === "triad") return true;
    return false;
  });
}

/**
 * Windows process alive check.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows process termination using taskkill /pid <pid> /T [/F].
 */
export async function terminateProcess(pid: number, options: { force?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;

  if (process.platform === "win32") {
    return new Promise((resolveTerm) => {
      const args = ["/pid", String(pid), "/T"];
      if (options.force) args.push("/F");
      const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
      killer.once("close", () => {
        resolveTerm(!isProcessAlive(pid));
      });
      killer.once("error", () => {
        resolveTerm(!isProcessAlive(pid));
      });
      setTimeout(() => resolveTerm(!isProcessAlive(pid)), options.timeoutMs ?? 3000).unref();
    });
  }

  try {
    process.kill(pid, options.force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Process already gone
  }
  return !isProcessAlive(pid);
}

/**
 * Retrieves the current netstat port-to-PID mapping on Windows.
 */
export function getLiveListeningPids(): Promise<Map<number, number>> {
  return new Promise((resolvePids) => {
    if (process.platform !== "win32") {
      resolvePids(new Map());
      return;
    }
    const proc = spawn("netstat", ["-ano", "-p", "tcp"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    proc.once("close", () => {
      resolvePids(parseNetstatOutput(output));
    });
    proc.once("error", () => {
      resolvePids(new Map());
    });
  });
}

/**
 * Default supervisor state file path.
 */
export function defaultStateFilePath(reposRoot?: string): string {
  const root = reposRoot ?? findReposRoot();
  return join(root, "sovereign-exocortex", "apps", "daemon", ".supervisor-pids.json");
}

/**
 * Default supervisor log directory.
 */
export function defaultLogDir(reposRoot?: string): string {
  const root = reposRoot ?? findReposRoot();
  return join(root, "sovereign-exocortex", "apps", "daemon", "logs");
}

/**
 * Command: status
 */
export async function supervisorStatus(options: { reposRoot?: string; stateFile?: string } = {}): Promise<void> {
  const reposRoot = options.reposRoot ?? findReposRoot();
  const stateFile = options.stateFile ?? defaultStateFilePath(reposRoot);
  const state = loadSupervisorState(stateFile);
  const listeningPids = await getLiveListeningPids();
  const supervisorPidSet = new Set(Object.values(state.processes).map((p) => p.pid));

  const statuses = await checkMeshStatus(MESH_NODES, {
    pidLookup: (port) => listeningPids.get(port) ?? null,
    supervisorPids: supervisorPidSet,
  });

  console.log("\nSovereign Exocortex 9-Service Local Mesh Status:");
  console.log(formatStatusTable(statuses));
  console.log("");
}

/**
 * Spawns a mesh service in the background and redirects stdio to logs.
 */
export function spawnDetachedService(
  spec: MishmashNodeSpec,
  reposRoot: string,
  logDir: string
): ChildProcess {
  const tsxPath = findTsxCli(reposRoot);
  const launchConfig = buildLaunchArgs(spec, { reposRoot, tsxPath });

  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const outPath = join(logDir, `${spec.id}.log`);
  const errPath = join(logDir, `${spec.id}.err.log`);

  const outFd = openSync(outPath, "a");
  const errFd = openSync(errPath, "a");

  const child = spawn(launchConfig.command, launchConfig.args, {
    cwd: launchConfig.cwd,
    env: launchConfig.env,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
  });

  closeSync(outFd);
  closeSync(errFd);
  child.unref();

  return child;
}

/**
 * Command: start
 */
export async function supervisorStart(options: { reposRoot?: string; stateFile?: string } = {}): Promise<void> {
  const reposRoot = options.reposRoot ?? findReposRoot();
  const stateFile = options.stateFile ?? defaultStateFilePath(reposRoot);
  const logDir = defaultLogDir(reposRoot);
  let state = loadSupervisorState(stateFile);
  const listeningPids = await getLiveListeningPids();

  console.log(`\nStarting local mesh services from ${reposRoot}...`);
  let startedCount = 0;

  for (const spec of MESH_NODES) {
    const isUp = await defaultProbePort(spec.port);
    if (isUp) {
      const pid = listeningPids.get(spec.port);
      console.log(`  [SKIP] ${spec.id.padEnd(24)} already listening on :${spec.port}${pid ? ` (PID ${pid})` : ""}`);
      continue;
    }

    try {
      console.log(`  [LAUNCHING] ${spec.id.padEnd(24)} on :${spec.port} via ${spec.runner}...`);
      const child = spawnDetachedService(spec, reposRoot, logDir);
      if (child.pid) {
        state = recordProcess(state, spec.id, child.pid, spec.port);
        saveSupervisorState(stateFile, state);
        startedCount++;
      }
    } catch (err) {
      console.error(`  [FAILED] ${spec.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (startedCount > 0) {
    console.log(`\nWaiting 3 seconds for ${startedCount} launched service(s) to bind ports...`);
    await new Promise((res) => setTimeout(res, 3000));
  }

  await supervisorStatus(options);
}

/**
 * Command: stop
 */
export async function supervisorStop(options: { reposRoot?: string; stateFile?: string } = {}): Promise<void> {
  const reposRoot = options.reposRoot ?? findReposRoot();
  const stateFile = options.stateFile ?? defaultStateFilePath(reposRoot);
  let state = loadSupervisorState(stateFile);

  const trackedEntries = Object.entries(state.processes);
  if (trackedEntries.length === 0) {
    console.log("\nNo active processes tracked by supervisor in state file.");
    await supervisorStatus(options);
    return;
  }

  console.log(`\nStopping ${trackedEntries.length} process(es) started by supervisor...`);
  for (const [id, proc] of trackedEntries) {
    if (isProcessAlive(proc.pid)) {
      console.log(`  Terminating ${id} (PID ${proc.pid}, port ${proc.port})...`);
      let stopped = await terminateProcess(proc.pid, { force: false, timeoutMs: 3000 });
      if (!stopped && isProcessAlive(proc.pid)) {
        console.log(`  Force killing ${id} (PID ${proc.pid})...`);
        stopped = await terminateProcess(proc.pid, { force: true, timeoutMs: 2000 });
      }
      if (stopped) {
        console.log(`  [STOPPED] ${id}`);
      } else {
        console.warn(`  [WARNING] ${id} (PID ${proc.pid}) could not be fully confirmed stopped.`);
      }
    } else {
      console.log(`  [ALREADY EXITED] ${id} (PID ${proc.pid})`);
    }
    state = removeProcess(state, id);
    saveSupervisorState(stateFile, state);
  }

  await supervisorStatus(options);
}

/**
 * Command: restart <id>
 */
export async function supervisorRestart(
  idOrAlias: string,
  options: { reposRoot?: string; stateFile?: string } = {}
): Promise<void> {
  const spec = findServiceSpec(idOrAlias);
  if (!spec) {
    console.error(`\nUnknown service: "${idOrAlias}". Available services:\n  ${MESH_NODES.map((n) => n.id).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const reposRoot = options.reposRoot ?? findReposRoot();
  const stateFile = options.stateFile ?? defaultStateFilePath(reposRoot);
  const logDir = defaultLogDir(reposRoot);
  let state = loadSupervisorState(stateFile);

  console.log(`\nRestarting service "${spec.id}" (port ${spec.port})...`);

  // Check if tracked by supervisor
  const tracked = state.processes[spec.id];
  if (tracked && isProcessAlive(tracked.pid)) {
    console.log(`  Stopping supervisor-tracked PID ${tracked.pid}...`);
    await terminateProcess(tracked.pid, { force: false, timeoutMs: 2500 });
    if (isProcessAlive(tracked.pid)) {
      await terminateProcess(tracked.pid, { force: true, timeoutMs: 2000 });
    }
    state = removeProcess(state, spec.id);
    saveSupervisorState(stateFile, state);
  }

  // Check if port is still occupied by any process
  const listeningPids = await getLiveListeningPids();
  const portPid = listeningPids.get(spec.port);
  if (portPid && isProcessAlive(portPid)) {
    console.log(`  Terminating active port listener on :${spec.port} (PID ${portPid})...`);
    await terminateProcess(portPid, { force: true, timeoutMs: 2000 });
  }

  // Give socket 1.5 seconds to release
  await new Promise((res) => setTimeout(res, 1500));

  // Spawn fresh
  console.log(`  Launching ${spec.id} on port ${spec.port} via ${spec.runner}...`);
  const child = spawnDetachedService(spec, reposRoot, logDir);
  if (child.pid) {
    state = recordProcess(state, spec.id, child.pid, spec.port);
    saveSupervisorState(stateFile, state);
    console.log(`  Spawned with PID ${child.pid}. Verifying port binding...`);
  }

  // Poll port for up to 5 seconds
  let bound = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((res) => setTimeout(res, 500));
    if (await defaultProbePort(spec.port)) {
      bound = true;
      break;
    }
  }

  if (bound) {
    console.log(`  [RESTARTED SUCCESSFULLY] ${spec.id} is UP on :${spec.port}`);
  } else {
    console.warn(`  [WAITING] ${spec.id} spawned, but port :${spec.port} has not responded yet.`);
  }

  await supervisorStatus(options);
}

/**
 * Main CLI entrypoint parser.
 */
export async function runSupervisorCli(args: string[]): Promise<void> {
  const command = args[0]?.toLowerCase() ?? "status";

  switch (command) {
    case "start":
      await supervisorStart();
      break;
    case "status":
      await supervisorStatus();
      break;
    case "stop":
      await supervisorStop();
      break;
    case "restart": {
      const targetId = args[1];
      if (!targetId) {
        console.error("Usage: supervisor restart <service-id>");
        console.error(`Available services: ${MESH_NODES.map((n) => n.id).join(", ")}`);
        process.exitCode = 1;
        return;
      }
      await supervisorRestart(targetId);
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(`
Sovereign Exocortex Local Mesh Process Supervisor

Usage:
  tsx ops/supervisor.ts start         Launch all mesh services not already listening
  tsx ops/supervisor.ts status        Display health and PID table across all 9 ports
  tsx ops/supervisor.ts stop          Cleanly terminate processes started by supervisor
  tsx ops/supervisor.ts restart <id>  Restart an individual service by ID

Services (9):
  ${MESH_NODES.map((n) => `${n.id.padEnd(24)} (port ${n.port}) - ${n.role}`).join("\n  ")}
`);
      break;
    default:
      console.error(`Unknown command: "${command}". Run "supervisor help" for usage.`);
      process.exitCode = 1;
  }
}
