# Delegate capability map (rows 2.1-2.2): design for Opus review

Status: APPROVED WITH CHANGES by Opus review (2026-10-28); changes below are applied in the implementation.

## Problem
`POST /network/delegate` (`apps/daemon/src/server.ts` ~2022) relays any envelope to any of 8 local nodes. The only gate is an admin-only stopgap: `deviceHasScope(admin | admin:write)`. Consequences: (a) a phone that is merely scoped to read cannot ping or search memory; (b) the only way to allow it is to hand it admin, which would also let it dispatch to the mesh; (c) there is no record of which action is safe. Row 2.1 asks for an explicit map, default deny; row 2.2 routes the endpoint through it and drops the admin-only stopgap.

## Design
New `apps/daemon/src/delegate-capabilities.ts`, a pure module (no I/O):

```ts
type Tier = "T0" | "T1" | "T2" | "T3" | "T4";
interface Capability { scopes: readonly string[]; tier: Tier; shadow: "allow" | "block" }
function resolveDelegate(to: string, action: string, payload: unknown): Capability | null  // null = deny
```

Rules:
1. **Default deny.** Unknown node, unknown action, or an action that is mapped but whose payload sub-action is not mapped returns `null` and the route answers 403 `{error: "delegation not permitted", to, action}`. The same 403 is returned for an unknown node so the map does not reveal which nodes exist. (Today unknown nodes return 404 from `relayEnvelope`; that stays reachable only for admin, see 3.)
2. **Keys are normalized** (`trim().toLowerCase()`) exactly as `parseDelegateEnvelope` and the shadow check do today, so the map and the shadow rule cannot disagree on spelling.
3. **Scope check.** The device needs at least one scope in `capability.scopes`. `admin` and `admin:write` satisfy every mapped entry (superset), so existing admin phones keep working. Admin gets NO exemption from default deny: an unmapped action is denied for admin too. This removes the "admin can relay anything" path.
4. **Shadow stays the outer rule and is evaluated from the map, not beside it.** `shadow: "block"` entries return 423 while `SHADOW !== "0"`, same body as today. Today's literal rule (`hermes-api` always, mesh `demote|synthesize|dispatch|playbook`) becomes entries in the table. A test asserts the table reproduces today's rule for every pre-existing blocked case, so this cannot loosen shadow.
5. `approve` / `reject` remain impossible here: `isApprovalAction` in `forwardDelegate` is untouched and also checked before the map (defense in depth).

## Table (node x action)
| Node | Action | Scopes (besides admin) | Tier | Shadow |
| --- | --- | --- | --- | --- |
| pieces-for-all | ping, status | `delegate:read` | T0 | allow |
| pieces-for-all | memory + payload.action `search` (or absent) | `delegate:read` | T0 | allow |
| pieces-for-all | memory + payload.action `add` | `delegate:write` | T2 | block |
| agent-mesh-mcp | ping, skills | `delegate:read` | T0 | allow |
| agent-mesh-mcp | dispatch, playbook, synthesize, demote | admin only (empty list) | T3 | block |
| pattern-analyzer | ping | `delegate:read` | T0 | allow |
| pattern-analyzer | rank | `delegate:read` | T1 | allow |
| pattern-analyzer | feedback | `delegate:write` | T2 | block |
| autonomous-triad | ping | `delegate:read` | T0 | allow |
| autonomous-triad | classify | `delegate:read` | T1 | allow |
| hermes-api | every action | admin only | T4 | block |
| registry-app, gut-instinct, tool-registry-heartbeat | ping | `delegate:read` | T0 | allow |
| registry-app, gut-instinct, tool-registry-heartbeat | anything else | not mapped (denied) | n/a | n/a |

Notes: tier labels follow `FINISH_LINE_PLAN`: T0 read-only, T1 pure compute, T2 writes local state, T3 spawns work, T4 touches devices. `classify` is mapped T1 because the triad only classifies; its `approve/reject` are already refused by `isApprovalAction`. The mobile client today only uses ping/status/memory-search style calls (verify in review).

## New scopes
`delegate:read`, `delegate:write`. Defaults: enrollment gives `telemetry:write` only (server.ts ~552), so no existing device gains anything. The two scopes are opt-in per device. The lone admin test device keeps full access through `admin`/`admin:write`, minus unmapped actions.

## Route change (row 2.2)
Order in the handler: parse body -> parse envelope -> `isApprovalAction` 403 -> `resolveDelegate` (403 if null) -> scope check against the resolved capability (403) -> shadow check from the resolved capability (423) -> `forwardDelegate`. The admin-only stopgap at the top of the handler is deleted. Body is parsed before the scope check now, so an unauthenticated-scope device can probe parse errors (400). Mitigation: authentication has already happened (this route is behind the JWT); a 400 leaks only the envelope grammar.

## Invariants kept
- SHADOW: unchanged default; no code path reads or writes the env var.
- `/network/approve`, attestation, event log, replay, approvals: not touched.
- No new servers or models.

## Tests
1. Table test: every (node, action) pair in `MISHMASH_LAUNCH` x {all mapped actions + 3 unmapped + empty + case/whitespace variants}.
2. Regression: every case the old shadow rule blocked is `shadow: block` in the table.
3. Route tests: read-scoped device reaches ping and memory.search only; cannot reach `memory.add`, `dispatch`, hermes-api; unscoped device gets 403 on everything; admin gets 403 on unmapped; `approve`/`reject` 403 for everyone; SHADOW=0 turns 423 into a forward only for `shadow: block` entries the device is scoped for.
4. Mutation check: delete one table row and confirm a test fails.

## Open questions for the reviewer
1. Is returning 403 (not 404) for unknown nodes right, given admin previously saw 404/409 for diagnostics?
2. Is "admin satisfies every mapped entry" acceptable, or should T3/T4 require a dedicated `delegate:actuate` scope even for admin?
3. `memory.add` is gated by sub-action in the payload. Is parsing payload inside the capability resolver acceptable, or should sub-actions be separate top-level actions (a protocol change in the memory node)?
4. Are the three non-implemented nodes (registry-app, gut-instinct, tool-registry-heartbeat) correctly ping-only?
5. Anything that lets a scoped device reach a T2+ action through a differently-cased or padded action, a payload field named `action`, or the mesh `skillId` fallback (`payload.skillId || payload.action`)?

## Opus review outcome (changes applied)
1. The resolver never normalizes: `to` and `action` must already match `/^[a-z][a-z0-9_-]*$/` or are denied, so the authorized string is the forwarded string. (The doc's earlier claim that `parseDelegateEnvelope` normalizes was wrong.)
2. The daemon overwrites `envelope.from` with `GATEWAY_NODE` before forwarding; `memory.add` authorizes on `from`.
3. registry-app (stage, speculate, release, pending_proposals, cache_status, reject), gut-instinct (contract) and tool-registry-heartbeat (inventory) are implemented upstream. Only `ping` is mapped; tests assert the rest is denied, admin included.
4. memory search uses its own scope `delegate:memory-read` (it fans out to LTM, archive, graph and Mem0); `delegate:read` covers ping/status-type calls only.
5. `release` consumes a registry approval nonce with no attestation. It is unmapped and `isApprovalAction` refuses it, so the denial does not rest on the map alone.
6. A scope pre-check (admin, admin:write, delegate:read, delegate:memory-read, delegate:write) runs before the body is read. "Unmapped", "missing scope" and "approval action" return the same 403 body.
7. Unknown nodes now return 403 (was 404 for admin); `audit-fixes.test.ts` updated. Shadow table reproduces the old rule (all of hermes-api incl. ping; mesh demote/synthesize/dispatch/playbook) and adds blocks on memory.add and pattern feedback.
Follow-ups not done: require a `delegate:actuate` scope before SHADOW=0 is ever used; log denied delegations to the event log; rate-limit `classify`. `pc:dashboard` gets `admin:write` automatically, so it is an admin device.
