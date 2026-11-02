# Allowlist audit — `packages/allowlist` (T3, 2026-11-01)

**Owner:** opencode · **Scope:** every import site, caller expectation vs. actual behavior, mismatches flagged.
**No code was changed.** Three findings need a human/Claude call; all are flagged, not fixed.

> **Second pass (same day):** a cross-repo check against the sibling checkout `C:\Users\micha\Desktop\projects\pieces-android-shizuku-fix` superseded parts of §2, F1 and F2 and surfaced a new gap (F3, pairing). Corrections are marked inline; full evidence in **§9**.

---

## 1. The premise in the plan doc is wrong in three ways

The plan (line 47) says the allowlist is "actually used across daemon/mesh/world-model/mobile via subpath imports." Verified against disk:

| Claim | Reality |
|---|---|
| Import as `@exocortex/allowlist` | Package is named **`@pieces-android/allowlist`**. Grepping `@exocortex/allowlist` returns **zero** import sites — only the spec JSON and the plan doc itself. |
| Used across daemon/mesh/world-model/mobile | **One** import site: `apps/daemon/src/server.ts:8`. |
| Subpath imports like `allowlist/dist/...` | **No `dist/` exists.** `main` points at `src/index.ts`. No `allowlist/dist` or `allowlist/src` import anywhere in the repo. |

The mesh/world-model/mobile hits for the word "allowlist" are **four unrelated concepts that share a name**, not this package:

- `packages/mesh/mcp-filter-proxy.ts` — MCP tool allowlist (+ SHA256 manifest)
- `packages/world-model/cognitive-gate.ts` — command auto-execution allowlist
- `packages/core/provenance.test.ts` — 6-consumer provenance allowlists
- `apps/mobile/src/pages/Status.tsx` — app-capture allowlist (user-facing picker)

None import `@pieces-android/allowlist`.

## 2. The header comment describes two programs that don't exist

`packages/allowlist/src/index.ts:5-7` says it is:

> "Single source of truth shared by BOTH Plan A's LAN proxy (`apps/proxy`) and Plan B's remote gateway (`apps/pieces-gateway`). Import this, do not copy it."

- `apps/proxy` — **does not exist** (apps/: `cli`, `daemon`, `desktop`, `mobile`, `neo4j-import`)
- `apps/pieces-gateway` — **does not exist**

The daemon logs `pieces-gateway listening on 0.0.0.0:PORT` (`server.ts:2496`), so the *name* survives as a log string, but the directory the comment points at is gone **from this repo**.

> **Correction (second pass):** `apps/proxy` and `apps/pieces-gateway` **do exist** — in the sibling checkout `pieces-android-shizuku-fix`, and both import this module (via their own physical copy of it, `file:../../packages/allowlist`). The header comment describes cross-repo reality accurately; what failed is the rule it states ("Import this, do not copy it"). The drift the comment warns about **has already happened** — see §9.

The "shared by two independently-deployed proxies" invariant is enforceable in principle — there are three consumers across two repos — but it is **not enforced in practice**, because the sibling repo vendored its own copy instead of importing this one.

## 3. `docs/ALLOWED_ROUTES.md` does not exist

`index.ts:1-3` makes every table entry conditional on it:

> "Every entry here must trace back to a 'Confirmed working' row in `docs/ALLOWED_ROUTES.md`. Do not add a route here without repeating the live-curl-evidence step documented there first."

Searched the whole repo (excluding `node_modules`): **no `ALLOWED_ROUTES*` file anywhere.**

So the provenance rule that governs what may enter the allowlist **has no artifact to trace to**. All 5 current entries are unverifiable against the documented evidence step. This is a process gap, not a code bug — but it means "deny-by-default" is currently "deny-by-default plus an undocumented list."

## 4. Behavior: what works

**Auth ordering is correct.** `verifyToken` runs at `server.ts:686`; the allowlist gate is at `server.ts:2435`. Unauthenticated requests are rejected before the allowlist is consulted.

**Deny-by-default holds.** `findAllowedRoute()` matches on exact `method` + exact `mobilePath`. Anything unmatched falls to `server.ts:2437-2441` → `404 { error: "not found" }`, even with a valid JWT. The comment there says exactly that, and it is true.

**All 6 bypass branches check `method`**, not just path (`isAsk` requires POST, `isAssetFetch` requires GET, etc.). No method-confusion hole.

**Dependency declaration is correct** — `apps/daemon/package.json` declares `"@pieces-android/allowlist": "workspace:*"`.

## 5. Findings that need a call (not fixed)

### F1 — `piecesPath` is dead data; the module's core mapping is never read

The type's whole point (`index.ts:12-14`) is:

```
mobilePath:  "/mobile/recent/assets"   // what the phone calls
piecesPath:  "/assets"                 // the real PiecesOS path
```

But the forward at `server.ts:2445` is:

```ts
const target = new URL(url.pathname + url.search, HOME_PROXY_BASE_URL);
```

`route.piecesPath` is **never referenced anywhere in the repo**. The gateway forwards the *mobile* path unchanged; it never rewrites to `piecesPath`.

Consequence: `ALLOWED_ROUTES` functions as a **boolean path/method gate only**. The `mobilePath → piecesPath` mapping is documentation-shaped code that no execution path consumes. Every reader of this module (including the header comment's "single source of truth") will assume rewriting happens.

*Why I didn't fix it:* either (a) the rewrite was lost in a port and routes are silently forwarding the wrong path — a behavior change I can't validate without live PiecesOS — or (b) `piecesPath` should be deleted. Both need a decision, not an agent guess. **Flagged, not fixed.**

### F2 — Two prefix bypasses are wider than the exact-match table

The exact-match table covers 5 routes. Six more paths skip the allowlist entirely (`server.ts:2422-2435`). Four are exact (`/mobile/ask`, `/mobile/search/relevant`, `/mobile/usage-report`, `/mobile/summaries`). Two are **prefix matches**:

```ts
isAssetFetch         = GET && pathname.startsWith("/mobile/asset/")
isConversationFetch  = GET && pathname.startsWith("/mobile/conversation/") && endsWith("/messages")
```

These forward an **arbitrary suffix** to the home proxy while attaching the gateway's `HOME_PROXY_TOKEN` (`server.ts:2448`). That is a wider forwarding surface than the exact-match allowlist grants — the token is the gateway's, so this is a confused-deputy shape: any authenticated device can make the gateway spend its own credential on any `/mobile/asset/*` path.

Not necessarily a hole — the home proxy may constrain what it serves under those prefixes. But **the allowlist is not what bounds it**, which is the opposite of what the module's name implies. *Flagged, not fixed*: determining whether the home proxy constrains the suffix requires reading `apps/proxy`-equivalent code that isn't in this repo.

## 6. Table routes vs. what the phone actually calls

Searched `apps/mobile/src` for each `mobilePath`:

| Table route | Called by mobile? |
|---|---|
| `GET /mobile/status/health` | **Yes** (`api.ts:220`) |
| `GET /mobile/status/version` | **Yes** (`api.ts:221`) |
| `GET /mobile/recent/assets` | **Yes** (`api.ts` timeout config + comment) |
| `GET /mobile/recent/conversations` | **No** — zero call sites |
| `GET /mobile/recent/search` | **No** — zero call sites |

And the reverse — paths the phone *does* call that are **not** in the table (handled by the bypass instead):

| Called by mobile | In table? |
|---|---|
| `/mobile/ask` | No — bypass branch |
| `/mobile/summaries` | No — bypass branch |
| `/mobile/usage-report` (`flush.ts:158`) | No — bypass branch |
| `/mobile/recent/assets` | **Yes** — only overlap |

**Two of five table entries appear dead.** Not a security issue (deny-by-default means an unused entry is inert), but it means the table is not a description of actual traffic.

## 7. Test and CI coverage: none

- `packages/allowlist/` contains exactly two files: `package.json`, `src/index.ts`. **No test file.**
- `package.json` has **no `scripts` field** — no `test`, no `typecheck`. Root `typecheck`/`test` are `pnpm -r --stream …`, which **skip packages lacking the script**. This package is therefore never typechecked and never tested by CI.
- The package is reachable only via `apps/daemon` tests, which exercise it incidentally.

The module has no independent guard: a typo'd route, a broken `findAllowedRoute` match, or a removed deny branch would not fail any test.

**`packages/allowlist` is the only TypeScript in the workspace that no typecheck ever covers.** Three projects lack a `typecheck` script (`packages/allowlist`, `apps/desktop`, `apps/neo4j-import`), but the other two contain zero `.ts`/`.tsx` files — `apps/desktop` is a Tauri shell and `apps/neo4j-import` is plain `.js` — so neither has anything to check. That leaves this package alone: 1 `.ts` file, no script, no test.

Repo-wide typecheck was run after this audit and **passes** (`pnpm -r --stream typecheck`, all 9 script-bearing projects `Done`, including `apps/daemon`). The green result does not cover this package, which is the point — a passing `pnpm -r typecheck` says nothing about the module that gates gateway request forwarding.

## 8. Summary

| # | Finding | Severity |
|---|---|---|
| F1 | `piecesPath` never read — mapping is dead, forward uses `url.pathname` | **Needs decision** |
| F2 | 2 prefix bypasses forward arbitrary suffixes with gateway token | **Needs decision** |
| 3 | `docs/ALLOWED_ROUTES.md` missing — provenance rule unverifiable | Process gap |
| 6 | 2 of 5 table routes never called by mobile | Dead config |
| 7 | Sole unchecked TypeScript in the workspace; no tests, no typecheck script | Coverage gap |
| 2 | Header comment cites two non-existent programs | Stale doc |
| 1 | Plan's grep target (`@exocortex/allowlist`) matches nothing | Wrong doc |

**The deny-by-default gate itself works and is correctly ordered after auth.** The gaps are that its provenance artifact is missing, its mapping half is dead, two bypasses are wider than it, and nothing tests it.

---

### Verification commands used

```
grep -r "@exocortex/allowlist"            # 0 import sites (plan's suggested command)
grep -r "@pieces-android/allowlist"       # 1 import site: apps/daemon/src/server.ts:8
grep -r "piecesPath"                      # only the type def + the unused binding at server.ts:2435
ls docs/ALLOWED_ROUTES*                   # not found
ls apps/                                  # no proxy, no pieces-gateway
ls packages/allowlist/                    # package.json + src/index.ts only
pnpm -r --stream typecheck                # passes; does NOT cover packages/allowlist
```
