# Setup & Onboarding Guide

> Start-from-nothing instructions for a new machine or a new person on this project. For what the system *does* once running, see [`USER_MANUAL.md`](USER_MANUAL.md). For the honest state of what's implemented vs. aspirational, see the root [`README.md`](../README.md)'s "Honest limits" section — read that before assuming a feature described here is production-hardened.

## 1. Prerequisites

| Requirement | Why | Verify |
|---|---|---|
| Node 24+ | Required across the workspace and enforced in root package.json engines | `node --version` |
| pnpm | Workspace package manager (13 projects) | `pnpm --version` |
| Python 3.10+ with a venv | `packages/triad` (advisory council / morphogenetic trials) | only needed if you touch `packages/triad` |
| Rust + Tauri prerequisites | Only for `apps/desktop` builds | only needed for desktop builds |
| Android SDK/toolchain | Only for building `apps/mobile`'s native Android app | only needed for mobile builds |
| Neo4j Desktop | Graph store for the Living World Model | project named `Exocortex`, DBMS id `fb85c09a-5124-4df7-9128-1bb9cfea6036` |
| A separately-running home proxy | `apps/daemon` requires its URL/token even for local-only use — **this proxy is not part of this repo**, it lives in a sibling checkout (`pieces-android-shizuku-fix/apps/proxy` as of 2026-10) | see §3 |

## 2. Clone and install

```powershell
git clone <this repo>
cd sovereign-exocortex
pnpm install
pnpm typecheck   # should be 0 errors across workspace TS projects (Python is skipped)
```

## 3. The home proxy (external dependency)

`apps/daemon` will not start without `HOME_PROXY_BASE_URL` and `HOME_PROXY_TOKEN` pointing at a running proxy, even if you only want local world-model use with no phone involved. As of this writing that proxy lives in a **separate sibling repository**, `pieces-android-shizuku-fix`, at `apps/proxy`.

```powershell
# in a sibling checkout, e.g. C:\Users\<you>\projects\pieces-android-shizuku-fix
cd apps/proxy
npm install
# generates apps/proxy/.bearer-token on first run if one doesn't exist
npm start
```
Confirm it's up: `curl http://127.0.0.1:8787/health` (expect `200`, or `401` if you add an `Authorization` header check — either confirms the process answers).

Get the token it's actually using:
```powershell
Get-Content apps\proxy\.bearer-token
```
You'll need this value for `HOME_PROXY_TOKEN` in the next step.

## 4. Configure the daemon

Create `apps/daemon/.env` (never commit this file):

```
GATEWAY_JWT_SECRET=<32+ random chars, e.g. openssl rand -base64 32>
HOME_PROXY_BASE_URL=http://127.0.0.1:8787
HOME_PROXY_TOKEN=<the token from apps/proxy/.bearer-token, §3>
GATEWAY_ENROLL_TOKEN=<your choice, required to enroll devices>
TRIAD_SERVER_TOKEN=<your choice, must match on both gateway and triad>
SHADOW=1
```

Start it:
```powershell
pnpm --filter @exocortex/daemon start
```
Confirm: `curl http://127.0.0.1:8788/mobile/health` → `200`.

> **Tip:** You can start the daemon with either `pnpm start` (which delegates to `@exocortex/daemon`) or `pnpm --filter @exocortex/daemon start`.

## 5. Enroll your phone and start the mobile app

In a second terminal, from the repo root:
```powershell
pnpm --filter @exocortex/daemon enroll -- "My Phone"
pnpm --filter @exocortex/mobile dev
```
`enroll` prints a device JWT — this is what the mobile app needs to talk to the daemon as an authorized device.

### Connecting the phone

The mobile app has two distinct pairing paths depending on how it's running — don't confuse them:

- **Running inside the Tauri desktop app** (`apps/desktop`): fully automatic. The desktop shell talks to the daemon over a native loopback IPC bridge and retrieves tokens itself — no QR code, no manual entry.
- **Running as a standalone installed Android app** (the normal case for an actual phone): manual QR pairing.
  1. On the PC, the `pieces-gateway` sibling-repo process (see §6) generates a short-lived, single-use pairing token and renders it as a QR code (`npm run pair` in that repo's `apps/pieces-gateway`, or via its CLI — check that repo's own docs for the exact current command).
  2. On the phone, open the app's **Setup** screen and use **Scan to Connect**.
  3. The app exchanges the scanned token for a device JWT via `POST /mobile/pair` and stores it.
  4. Verify: Setup screen should show both LAN and/or remote health checks green.

If pairing fails with an auth error, check the ["pieces-gateway vs. the daemon: same default port, different apps"](#pieces-gateway-vs-the-daemon-same-default-port-different-apps) pitfall below before assuming the token itself is wrong — it is the single most common setup failure on a fresh machine running both this repo and the sibling proxy/gateway repo.

## 6. (Optional) The wider local mesh

If you want the full 9-service mesh (this daemon plus 8 sibling-repo services — `hermes-api`, `autonomous-triad`, `pieces-for-all`, `agent-mesh-mcp`, `pattern-analyzer`, `registry-app`, `gut-instinct`, `tool-registry-heartbeat`; see [`mishmash-nodes.ts`](../apps/daemon/src/mishmash-nodes.ts)), those are **separate sibling checkouts**, not embedded packages in this repo — the mesh launcher expects them to exist as directories next to this one.

Once those checkouts exist, start/monitor everything with the supervisor:
```powershell
cd apps/daemon
npx tsx ops/supervisor.ts status    # see what's up/down right now
npx tsx ops/supervisor.ts start     # bring up anything that's down
```

To make this automatic at every boot/logon (Windows, recommended once the mesh is working manually):
```powershell
# Run elevated (admin) once per task:
Register-ScheduledTask -TaskName "MeshSupervisorStartup" `
  -Action (New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<repo>\apps\daemon\ops\supervisor-startup.ps1"') `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn),(New-ScheduledTaskTrigger -AtStartup) `
  -Settings (New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden) `
  -Principal (New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType S4U -RunLevel Limited) -Force
```
The watchdog (restarts anything that dies) is a `schtasks /Create /XML` import of a 2-minute repeating trigger pointed at `ops/supervisor-watchdog.ps1`, same hidden/S4U pattern — see that script's own header comment for the exact XML shape if `Register-ScheduledTask` doesn't support the repetition interval cleanly on your Windows build. The startup and watchdog scripts also call `ops/ensure-llama-server.ps1`, which keeps the local llama.cpp servers (triage `:8080`, embeddings `:8081`, vision `:8082`) available at boot and recovers each on later health checks. Run `ops/export-ollama-models.ps1` once to copy the model files out of Ollama; embeddings and vision are skipped until their files exist.

## 7. Neo4j

1. Open Neo4j Desktop, create or select the project containing the `Exocortex` DBMS.
2. Start it. Confirm `curl http://127.0.0.1:7474` → `200`.
3. The daemon syncs entities into it automatically once both are running — no manual import needed for day-to-day use. For a one-time bulk import/evaluation workflow, see `apps/neo4j-import`.

## 8. Verify everything end-to-end

```powershell
curl http://127.0.0.1:8788/mobile/health   # daemon
curl http://127.0.0.1:8787/health          # home proxy (sibling repo)
curl http://127.0.0.1:7474                 # neo4j
```
All three `200` means the core loop (phone/PC signals → event log → world model → Neo4j) is live. `SHADOW=1` (the default — keep it while calibrating) means the system is observing and proposing but never auto-executing; see the README's Emergency Safety Circuit Breakers section before changing that.

---

## Known pitfalls

### pieces-gateway vs. the daemon: same default port, different apps

`apps/daemon` (this repo, port `8788` by default) and `apps/pieces-gateway` (the sibling `pieces-android-shizuku-fix` repo, **also** port `8788` by default in its source) are two completely separate codebases that happen to hardcode the identical default port number. If both are ever started on the same machine, whichever process binds first silently wins the port — the other fails to bind or, if something (like a Tailscale `serve` rule) is pointed at that port expecting the *other* service, requests get routed to the wrong app entirely. The symptom is usually a confusing auth failure (e.g. `"jwt malformed"` or `"invalid signature"`) rather than a connection error, because the wrong server answers but rejects the token meant for the right one.

**Fix applied in this environment:** `pieces-gateway`'s `.env` sets `GATEWAY_PORT=8790` instead of the 8788 default, and any `tailscale serve` rule exposing it points at `8790`. If you're setting this up fresh and hit an inexplicable pairing/auth failure, check:
```powershell
netstat -ano | findstr "8788 8790"
tailscale serve status
```
and confirm the port `tailscale serve` forwards to actually matches the process you intend to reach.

### Two separate Android apps used to share one App ID

Historically, `sovereign-exocortex/apps/mobile` and `pieces-android-shizuku-fix/apps/mobile` both built an Android app with the identical `appId` (`com.pieces.android.companion`) — installing one overwrote the other. As of 2026-10-25, `pieces-android-shizuku-fix`'s `apps/mobile` has been retired entirely; **this repo's `apps/mobile` is now the only mobile app client.** If you're working from an older checkout or a stale APK, rebuild from this repo, not the sibling one.
