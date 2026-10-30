# Spec: Workstation Node service controls (2026-10-29)

Author: planner (Claude). Implementer: another model. Do not change this spec; raise questions in the PR.
Worktree: `C:\Users\micha\projects\sovereign-exocortex-nodes`, branch `feat/workstation-node-controls` (from `origin/main`). Work only here. Another agent uses `C:\Users\micha\projects\sovereign-exocortex` on a different branch; never touch that checkout.

## 0. The ask (user, verbatim intent)

On the desktop app, tab "Workstation Node", on the Workstation Node card, each of the four rows (Daemon API, Proxy Bus, PiecesOS Engine, World Model Store) gets an **expandable dropdown** showing **status (healthy / unhealthy)** and a **Restart** button. Restart restarts that service.

## 1. What exists (verified)

- The card is in `apps/mobile/src/pages/Status.tsx` (heading "Windows Workstation Node", about line 430), rendered only when `!Capacitor.isNativePlatform()`. The Tauri desktop app (`apps/desktop`) wraps the same React UI, so one change serves desktop and web. Tab label "Workstation Node" is in `apps/mobile/src/components/Layout.tsx`.
- Today the four rows are static: Daemon API `:8788`, Proxy Bus `:8787`, PiecesOS Engine `:39300`, World Model Store "SQLite (WAL)". The badge "Localhost Online" is **hardcoded**. Replace it with a real roll-up of the four statuses.
- Tauri (`apps/desktop/src-tauri/src/lib.rs`) has one command, `get_local_config`, which GETs `127.0.0.1:8788/mobile/local-config`. That endpoint (loopback only) issues an admin-scoped JWT (`admin:read`, `admin:write`). Reuse that auth for the new calls.
- The daemon has `GET /mobile/health` (unauthenticated liveness, returns `{ok:true}`).
- Processes and how they are run (important, do not guess):
  - **Daemon API :8788**: node `apps/daemon/src/server.ts`, started by Windows scheduled task `ExocortexDaemon` and the mesh supervisor (`MeshSupervisorStartup`, `MeshSupervisorWatchdog`).
  - **Proxy Bus :8787**: the Pieces Android proxy, run by scheduled task `PiecesAndroidProxy` (state Running; has a `PiecesAndroidProxyWatchdog`). Code lives in a **different repo** (`pieces-android-shizuku-fix` / `apps/proxy`); do not edit that repo.
  - **PiecesOS Engine :39300**: the `os_server` process of Pieces for Developers; a `PiecesOSInteractiveLauncher` scheduled task exists. 17 GB local database, so restarts are slow.
  - **World Model Store**: the daemon's SQLite database (WAL) opened in-process (`db-host.ts` `setDatabase`, `WorldModelHost`).
- **Known restart traps (from `apps/daemon/ops/restart-exocortex.ps1` and prior incidents):**
  - `npx tsx apps/daemon/ops/supervisor.ts restart daemon` can report success while the new process dies with `EADDRINUSE`; the old listener keeps running. Do not use it as the restart path.
  - The processes are children of an S4U scheduled task, so a normal (non-elevated) shell gets "Access is denied" killing them. `restart-exocortex.ps1` needs an elevated PowerShell. Stopping the scheduled task alone does not stop its children.
  - Restarting must kill the old listener by port **and** the old supervisor process, wait for the port to free, then start via the scheduled task, then poll health.
  - `restart-exocortex.ps1` deliberately never touches 8787/39300. The new feature must treat those as separate, explicit actions.

## 2. Design

### 2.1 Backend: service registry and health (daemon)

New module `apps/daemon/src/ops-services.ts` (plus routes in `server.ts`), no new dependencies.

A fixed registry of exactly four ids: `daemon`, `proxy`, `piecesos`, `worldmodel`. Each has: label, port (if any), a `health()` function, a `restart()` function. **No id outside this list is ever accepted. No request field is ever put into a shell command line.**

`GET /ops/services` (loopback only AND `admin:read`) returns for each id:
`{ id, label, status: "healthy"|"unhealthy"|"unknown", detail: string, latency_ms: number|null, checked_at: ms, port?: number, pid?: number, uptime_s?: number, restart: { available: boolean, in_progress: boolean, last_at: ms|null, last_result: "ok"|"failed"|null } }`.

Health definitions:
- `daemon`: self. Healthy if the process is serving; report pid, uptime, version/git sha if cheap.
- `proxy`: HTTP request to `http://127.0.0.1:8787` with a 2 s timeout. **Find the real health path** by reading the proxy source (read-only, `C:\Users\micha\Desktop\projects\pieces-android-shizuku-fix\apps\proxy`) and the scheduled task definition; if it has no health route, a successful TCP connect plus any HTTP response counts as healthy and say so in `detail`. Do not send credentials; if the proxy needs the bearer token for every route, use TCP-connect-only and report that.
- `piecesos`: `GET http://127.0.0.1:39300/.well-known/health` (verify the path against the running instance with a read-only curl) with a 2 s timeout.
- `worldmodel`: the open database handle answers `PRAGMA quick_check` (cap runtime; use `PRAGMA quick_check(1)`), WAL file size under a sane limit (report size), last event age. Unhealthy if the check fails or the handle is closed.
- Any timeout/exception = `unhealthy` with a short `detail` (error class only; no paths, tokens or stack traces). "unknown" only before the first check or when the endpoint itself cannot be reached.
Run the four checks in parallel with a short per-check timeout; the whole endpoint returns within about 3 s. Cache results for 2 s so a polling UI cannot stampede.

`POST /ops/services/:id/restart` (loopback only AND `admin:write`):
- Validates `:id` against the registry, returns 404 otherwise.
- Returns **202 immediately** with `{ accepted: true, id }` **before** doing anything that could kill the daemon, then runs the restart detached.
- One restart per service at a time (409 if in progress) and a 30 s cooldown per service (429).
- Writes an audit entry (existing audit mechanism; who/which device, service id, time, result). No secrets.
- Rejects non-loopback callers with 403 even if the token is valid, and ignores any body.

### 2.2 How each restart actually works

The daemon cannot reliably restart itself or elevated children from inside a request. Use **pre-registered scheduled tasks as the privilege boundary**:

- Create `apps/daemon/ops/restart-service.ps1` taking `-Service daemon|proxy|piecesos|worldmodel` validated with `ValidateSet`, nothing else. It implements the restart for that service and logs to `apps/daemon/logs/restart-<service>.log`.
- Create `apps/daemon/ops/register-restart-tasks.ps1` (run **once, by the user, from an elevated PowerShell**; the implementer must not run it) that registers one scheduled task per service: `ExocortexRestart-daemon`, `-proxy`, `-piecesos`, `-worldmodel`, each running `powershell -NoProfile -ExecutionPolicy Bypass -File restart-service.ps1 -Service <id>` with the **Highest** run level, S4U logon (same as the existing tasks), and permission for the interactive user to start it. A non-elevated process can then run `schtasks /run /tn ExocortexRestart-<id>`. The daemon spawns only that fixed command string for a validated id. Document exactly what the user must run and what it changes. If the user has not run it, `restart.available` is false and the UI says "Restart task not installed" with the one-line command.
- Per-service behavior inside `restart-service.ps1`:
  - `daemon`: follow `restart-exocortex.ps1`: stop the `ExocortexDaemon` task, kill the listener on 8788 and the old mishmash supervisor processes (`mishmash-up.ts`), wait for the port to free, `Start-ScheduledTask ExocortexDaemon`, poll `http://127.0.0.1:8788/mobile/health` up to 60 s. **Do not use `supervisor.ts restart daemon`.** Do not touch other mesh ports.
  - `proxy`: stop then start scheduled task `PiecesAndroidProxy` (and kill the listener on 8787 if the task stop leaves it), wait for the port, poll. Never edit the proxy repo or its token files.
  - `piecesos`: gracefully stop `os_server` (try the app's own quit route or `Stop-Process` without `-Force` first; force only after a timeout), start via the `PiecesOSInteractiveLauncher` task, poll `39300` up to 120 s (it is slow). Never delete or touch the Pieces data directory.
  - `worldmodel`: **in-process, no process restart** (see 2.3).
- The script exits non-zero on failure and writes the last 20 log lines the UI can show on failure (via `detail`).

### 2.3 World Model Store "restart"

It is a SQLite handle inside the daemon, so a process restart is the wrong tool. Define restart as: stop the ingest consumer cleanly, `PRAGMA wal_checkpoint(TRUNCATE)`, close and reopen the database handle (`setDatabase`), restart the ingest consumer and world model host, then re-run `quick_check`. It runs inside the daemon (the `restart-service.ps1` path is not used for this id). It must not lose events: events in flight are queued or rejected with a retryable error, never dropped silently. If this cannot be done safely with the current `db-host.ts`/`ingest-consumer` design, **stop and report to the user** instead of faking it (a fallback of "restart the daemon" would be a different behavior and needs the user's approval).

### 2.4 UI (`Status.tsx`, new component `ServiceRow.tsx` or similar)

- Each of the four metric boxes becomes an expandable row (accessible: `button` with `aria-expanded`, keyboard operable). Collapsed: label, port/descriptor, and a status dot + word ("Healthy" / "Unhealthy" / "Checking"). Expanded: status, detail, latency, pid/uptime when known, last checked time, last restart result, and a **Restart** button.
- Colors: reuse existing `badge success` / danger styles; do not rely on color alone (text label always).
- Replace the hardcoded "Localhost Online" badge with a roll-up: all healthy = "All services healthy"; any unhealthy = "N unhealthy"; before first load = "Checking".
- Poll `GET /ops/services` every 10 s while the page is visible and the Status tab is open (stop when hidden/unmounted). Refresh immediately after a restart.
- Restart flow: click Restart, an inline confirm ("Restart Daemon API? The app will reconnect.") with Confirm / Cancel. Confirm calls POST, button shows "Restarting…" and is disabled. Poll health every 2 s until healthy again or 90 s (piecesos 150 s); then show "Restarted" or "Restart failed: <detail>". For `daemon`, loss of connection during the restart is expected; show "Reconnecting…", do not show an error banner, and recover automatically.
- Daemon restart must not log the user out or break the Tauri window; the UI re-fetches `/mobile/local-config` for a fresh token after reconnect.
- Where the service ops cannot be reached at all (daemon down), show all four rows as "Unknown (daemon unreachable)" with only a "Retry" action, and a hint about the Daemon row being restartable from the tray or by `Start-ScheduledTask ExocortexDaemon`.
- Calls go through the existing API layer (`apps/mobile/src/lib/api.ts` or similar) using the admin token from local config; add typed functions `getServices()` and `restartService(id)`. No Tauri command is required because the UI already reaches the daemon over loopback HTTP; do not add one unless a CORS/loopback issue forces it (explain in the PR if so).

## 3. Security requirements (all mandatory)

1. Loopback only AND admin scope on both routes. Remote/Tailscale requests get 403 for `/ops/*` even with a valid token. Test it.
2. Fixed registry, validated ids, fixed command strings. No user input in any shell string. No `shell: true` with interpolation.
3. Responses never include env vars, tokens, file paths outside the repo's `logs/` names, or raw stack traces.
4. Audit every restart request (accepted, rejected, outcome).
5. Rate limit and single-flight per service.
6. `register-restart-tasks.ps1` is a script for the user to run elevated. The implementer must not execute it, must not elevate, and must not modify existing scheduled tasks.

## 4. Tests (required)

- Daemon: `ops-services.test.ts`: registry rejects unknown ids (404) and path tricks (`..`, encoded, case variants); 403 for non-loopback and for tokens without `admin:write` (restart) / `admin:read` (list); 202 returned before the restart runs (use a fake process runner that blocks); single-flight 409 and cooldown 429; health mapping for timeout/refused/200/non-200/exception using injected fakes (no real network, no real process spawn in tests); `worldmodel` restart round-trip with an in-memory DB (events ingested before and after survive; none lost); the spawned command is exactly the fixed string for each id; audit entries written; responses contain no paths or secrets. Add the file to the daemon `package.json` test list.
- Mobile vitest: `Status.test.tsx` additions: rows render collapsed with status text; expand shows detail and Restart; confirm step required; disabled while restarting; failure shows detail; daemon-restart connection loss shows "Reconnecting…" and recovers; roll-up badge states; polling stops on unmount; native (Android) build does not render the card (existing behavior preserved).
- PowerShell: add Pester tests only if Pester is already used in the repo; otherwise a dry-run mode (`-WhatIf`) that prints the steps without acting, and exercise it in the PR description.
- Phone/desktop checks for the user (list in the PR): P1 the four rows show real status; P2 stop the proxy task manually, the Proxy row turns unhealthy within 10 s, Restart brings it back; P3 Daemon restart from the UI reconnects within 60 s and mesh ports other than 8788 are untouched (`Get-NetTCPConnection`); P4 PiecesOS restart returns healthy and no data directory change; P5 World Model restart with a live phone sending events loses none (`/v3/events/verify`).

## 5. Do not

- Do not run `register-restart-tasks.ps1`, change scheduled tasks, kill any process or restart any service while developing, except in an explicit test the user approves. Ask the user first for any real restart.
- Do not edit the proxy repo, PiecesOS files or its data directory.
- Do not use `supervisor.ts restart daemon` as the daemon restart path.
- Do not add an "unauthenticated restart" or accept restart from non-loopback.
- Do not add new runtime dependencies without saying why in the PR.
- Do not touch the other checkout (`C:\Users\micha\projects\sovereign-exocortex`) or its branches.

## 6. Process

PR from `feat/workstation-node-controls` to `main`. Before the PR, from this worktree:
`(cd apps/mobile && npx tsc --noEmit && npx vitest run)`, `(cd apps/daemon && npx tsc --noEmit && node --env-file-if-exists=.env --import tsx --test src/ops-services.test.ts src/v3-events.test.ts)`, and the full `pnpm typecheck`. Wait for CI (`check`, `docker-isolation`), then merge. Report honestly what was not verified on the real machine. After merge, the user runs `register-restart-tasks.ps1` once from an elevated PowerShell.
