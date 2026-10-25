#!/usr/bin/env node
/**
 * @file apps/daemon/ops/supervisor.ts
 * Process supervisor for the 9-service local mesh defined in apps/daemon/src/mishmash-nodes.ts.
 *
 * OVERVIEW & SERVICE TOPOLOGY:
 * This script provides high-reliability, zero-downtime lifecycle management (start, status,
 * stop, restart) for the 9 local microservices comprising the Sovereign Exocortex mesh:
 *
 *   1. hermes-api (port 3000): Phone & Android companion relay (tsx, mishmash/delegate.ts)
 *   2. autonomous-triad (port 8789): Python Multi-agent orchestrator & advisory server (python, triad.server)
 *   3. pieces-for-all (port 39400): Local LTM vector memory gateway (tsx, src/server.ts)
 *   4. agent-mesh-mcp (port 39401): Dynamic MCP tool switchboard (tsx, src/mishmash-delegate.ts)
 *   5. pattern-analyzer (port 39402): Real-time pattern lifecycle ranker (tsx, src/mishmash-delegate.ts)
 *   6. registry-app (port 39403): SecondGuess staging surface over pattern library (tsx, mishmash/delegate.ts)
 *   7. gut-instinct (port 39404): On-device coach contract node (node, mishmash/delegate.mjs)
 *   8. tool-registry-heartbeat (port 39405): Scheduled inventory task daemon (node, mishmash/delegate.mjs)
 *   9. daemon (port 8788): Sovereign Exocortex host daemon & event orchestrator (tsx, apps/daemon/src/server.ts)
 *
 * ARCHITECTURAL DESIGN CHOICES:
 * 1. Non-Intrusive `start`:
 *    Services already listening on their designated ports are preserved and skipped. Only down
 *    services are spawned in the background.
 *
 * 2. Scoped PID Tracking on `stop`:
 *    Only processes initiated by this supervisor script are recorded into `.supervisor-pids.json`.
 *    The `stop` command safely terminates supervisor-spawned processes using Windows `taskkill`
 *    process trees (/T), ensuring external tasks (such as pre-existing Windows S4U scheduled tasks)
 *    are never unintentionally disrupted.
 *
 * 3. Targeted `restart <id>`:
 *    Terminates any active listener on the target port, ensures clean socket release, restarts
 *    the node with fresh environment configurations, and polls the port until healthy.
 *
 * 4. Windows Native Compatibility:
 *    All paths are resolved with native Windows backslashes (\). Virtual environments (e.g. .venv)
 *    are preferred for Python nodes when present. Detached processes have stdio safely redirected
 *    to `apps/daemon/logs/<id>.log`.
 *
 * 5. Scope Boundary:
 *    Auto-restart watchdog loops are intentionally out of scope for this pass; lifecycle control
 *    is strictly command-driven.
 *
 * USAGE:
 *   npx tsx ops/supervisor.ts status
 *   npx tsx ops/supervisor.ts start
 *   npx tsx ops/supervisor.ts stop
 *   npx tsx ops/supervisor.ts restart hermes-api
 *   npx tsx ops/supervisor.ts restart daemon
 */

import { runSupervisorCli } from "../src/supervisor-core.js";

void runSupervisorCli(process.argv.slice(2));
