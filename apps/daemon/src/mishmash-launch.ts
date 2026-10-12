import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MISHMASH_LAUNCH, type MishmashNodeSpec } from "./mishmash-nodes.js";

export { MISHMASH_LAUNCH, type MishmashNodeSpec };

export interface MishmashHandle {
  children: ChildProcess[];
  env: Record<string, string>;
  upstreams: Record<string, string>;
  logs: () => string;
}

function looksLikeRepoRoot(dir: string): boolean {
  return existsSync(join(dir, "hermes-api"))
    && existsSync(join(dir, "autonomous-triad"))
    && existsSync(join(dir, "pieces-for-all"));
}

export function defaultReposRoot(): string {
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (looksLikeRepoRoot(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(process.cwd(), "../../..");
}

function tsxCliNear(path: string): string | null {
  const normalized = path.startsWith("file://") ? fileURLToPath(path) : path;
  if (!existsSync(normalized)) return null;
  const cli = join(dirname(normalized), "cli.mjs");
  if (existsSync(cli)) return cli;
  if (normalized.endsWith(`${sep}cli.mjs`) || normalized.endsWith(`${sep}cli.cjs`)) return normalized;
  return null;
}

export function tsxBin(): string | null {
  const fromEnv = process.env.MISHMASH_TSX;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const arg of process.execArgv) {
    const cli = tsxCliNear(arg);
    if (cli) return cli;
  }
  for (const arg of process.argv) {
    if (!arg || !existsSync(arg)) continue;
    let resolved = arg;
    try {
      resolved = realpathSync(arg);
    } catch {
      resolved = arg;
    }
    if (resolved.includes(`${sep}tsx${sep}`) || resolved.endsWith(`${sep}tsx`)) return resolved;
  }
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "../node_modules/tsx/dist/cli.mjs"),
  ];
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, "node_modules/tsx/dist/cli.mjs"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function pingBody(id: string): string {
  return JSON.stringify({
    v: 1,
    id: "0123456789abcdef",
    from: "pieces-android-companion-seamless",
    to: id,
    capability: "health",
    action: "ping",
    payload: {},
  });
}

function watchChild(id: string, child: ChildProcess): Promise<never> {
  const p = new Promise<never>((_, reject) => {
    child.once("error", (err) => reject(new Error(`${id} spawn error: ${err.message}`)));
    child.once("exit", (code, sig) => reject(new Error(`${id} exited early with code=${code} sig=${sig}`)));
  });
  p.catch(() => {}); // prevent unhandledRejection if exit happens post-startup
  return p;
}

export async function waitForPing(
  id: string,
  upstream: string,
  log: () => string,
  child?: ChildProcess,
  timeoutMs = 20_000,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  // The triad refuses every delegate action without its server token (same rule as forwardDelegate).
  const authHeader: Record<string, string> =
    id === "autonomous-triad" && env.TRIAD_SERVER_TOKEN ? { Authorization: `Bearer ${env.TRIAD_SERVER_TOKEN}` } : {};
  const deadline = Date.now() + timeoutMs;
  let last = "not started";
  let spawnError: Error | null = null;
  child?.once("error", (err) => {
    spawnError = err;
  });
  const childFailure = (): string | null => {
    if (spawnError) return `spawn error: ${(spawnError as Error).message}`;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      return `exited early with code=${child.exitCode} sig=${child.signalCode}`;
    }
    return null;
  };
  while (Date.now() < deadline) {
    const failed = childFailure();
    if (failed) throw new Error(`${id} ${failed}\n${log()}`);
    try {
      const response = await fetchImpl(new URL("/mishmash/delegate", upstream), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: pingBody(id),
        signal: AbortSignal.timeout(1500),
      });
      if (response.status === 200) {
        const json = (await response.json().catch(() => null)) as { ok?: boolean; from?: string } | null;
        if (json && json.ok === true && json.from === id) {
          return;
        }
        last = `200 but unexpected reply from ${id}: ${JSON.stringify(json)}`;
      } else {
        last = `${response.status} ${(await response.text()).slice(0, 300)}`;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const failed = childFailure();
  if (failed) throw new Error(`${id} ${failed}\n${log()}`);
  throw new Error(`${id} did not answer ping (${last})\n${log()}`);
}

export function buildChildEnv(portVariable: string, port: number, extraEnv: Record<string, string> = {}, nodeId?: string): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "windir",
    "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA",
    "NODE_PATH", "NODE_OPTIONS", "PYTHONPATH",
    "LOCAL_LTM_FILE", "PIECES_OS_URL", "MISHMASH_TSX", "MISHMASH_PYTHON",
    "PYTHONIOENCODING", "PYTHONUTF8"
  ];
  const env: NodeJS.ProcessEnv = {
    PYTHONUNBUFFERED: "1",
    [portVariable]: String(port),
    ...extraEnv,
  };
  // Only the triad gets its own server token; no other node child sees it.
  if (nodeId === "autonomous-triad" && process.env.TRIAD_SERVER_TOKEN) {
    env.TRIAD_SERVER_TOKEN = process.env.TRIAD_SERVER_TOKEN;
  }
  // Likewise only the memory gateway may search the archive; no other node sees the databank token.
  if (nodeId === "pieces-for-all") {
    for (const key of ["DATABANK_URL", "DATABANK_TOKEN"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

export async function startMishmash(options: {
  reposRoot?: string;
  ports?: Record<string, number>;
} = {}): Promise<MishmashHandle> {
  const reposRoot = options.reposRoot ?? defaultReposRoot();
  const tsx = tsxBin();
  const needsTsx = MISHMASH_LAUNCH.some((spec) => spec.runner === "tsx");
  if (needsTsx && !tsx) {
    throw new Error("tsx is required to start the TypeScript mishmash nodes");
  }
  const missing = MISHMASH_LAUNCH.filter((spec) => !existsSync(join(reposRoot, spec.repo)));
  if (missing.length > 0) {
    throw new Error(`missing repos: ${missing.map((spec) => spec.repo).join(", ")}`);
  }

  const pythonBin = process.env.MISHMASH_PYTHON || (process.platform === "win32" ? "python" : "python3");

  const children: ChildProcess[] = [];
  let stderr = "";
  const capture = (id: string, child: ChildProcess) => {
    const take = (chunk: Buffer) => {
      stderr = (stderr + `[${id}] ` + chunk.toString("utf8")).slice(-8000);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err) => {
      stderr = (stderr + `[${id} error] ` + err.message + "\n").slice(-8000);
    });
  };
  const logs = () => stderr;
  const upstreams: Record<string, string> = {};
  const env: Record<string, string> = {};

  try {
    for (const spec of MISHMASH_LAUNCH) {
      const port = options.ports?.[spec.id] ?? spec.port;
      const upstream = `http://127.0.0.1:${port}`;
      upstreams[spec.id] = upstream;
      env[spec.envKey] = upstream;
    }
    for (const spec of MISHMASH_LAUNCH) {
      const port = options.ports?.[spec.id] ?? spec.port;
      const cwd = join(reposRoot, spec.repo);
      const childEnv = buildChildEnv(spec.portVariable, port, env, spec.id);
      let child: ChildProcess;
      if (spec.runner === "python") {
        child = spawn(pythonBin, ["-m", spec.script], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      } else if (spec.runner === "tsx") {
        child = spawn(process.execPath, [tsx as string, spec.script], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      } else {
        child = spawn(process.execPath, [spec.script], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      }
      capture(spec.id, child);
      children.push(child);
    }
    await Promise.all(
      MISHMASH_LAUNCH.map((spec, i) =>
        Promise.race([
          waitForPing(spec.id, upstreams[spec.id] as string, logs, children[i] as ChildProcess),
          watchChild(spec.id, children[i] as ChildProcess),
        ])
      )
    );
    return { children, env, upstreams, logs };
  } catch (err) {
    await stopMishmash({ children, env, upstreams, logs });
    throw err;
  }
}

export async function stopMishmash(handle: MishmashHandle): Promise<void> {
  for (const child of handle.children) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          const timer = setTimeout(finish, 5000);
          try {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
            killer.on("close", (code) => {
              clearTimeout(timer);
              if (code !== 0 && code !== 128) {
                child.kill("SIGTERM");
              }
              finish();
            });
            killer.on("error", () => {
              clearTimeout(timer);
              child.kill("SIGTERM");
              finish();
            });
          } catch {
            clearTimeout(timer);
            child.kill("SIGTERM");
            finish();
          }
        });
      } else {
        child.kill("SIGTERM");
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const child of handle.children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process already exited.
      }
    }
  }
}
