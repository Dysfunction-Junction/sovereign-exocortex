# Allowlist audit — `packages/allowlist` (T3, 2026-11-01)

**Owner:** opencode · **Scope:** every import site, caller expectation vs. actual behavior, mismatches flagged.
**No code was changed.** Two findings need a human/Claude call — F3 (pairing, §5) and the copy drift (§9); F1 and F2 from the first pass are now **resolved** against the sibling checkout, see the inline correction notes.

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

## 2. The header comment points at two programs that live in a different repo

`packages/allowlist/src/index.ts:5-7` says it is:

> "Single source of truth shared by BOTH Plan A's LAN proxy (`apps/proxy`) and Plan B's remote gateway (`apps/pieces-gateway`). Import this, do not copy it."

- `apps/proxy` — **not in this repo** (apps/: `cli`, `daemon`, `desktop`, `mobile`, `neo4j-import`)
- `apps/pieces-gateway` — **not in this repo**

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

> **Resolved (second pass): option (a) is correct — the rewrite exists, one hop downstream.** The forward target `HOME_PROXY_BASE_URL` is the Plan A LAN proxy in the sibling checkout, and *that* caller does use the mapping: `apps/proxy/src/server.ts:634` (`pieces-android-shizuku-fix`) builds `new URL(route.piecesPath, PIECES_BASE_URL)` and only copies `url.search`. So `piecesPath` is not dead module-wide — the gateway (boolean gate, forwards mobile path) and the proxy (rewrites to PiecesOS path) each consume half of the type, exactly as the two-consumer header describes. `route.piecesPath` is dead *within this repo only*. No behavior change needed; deleting the field would break the sibling caller. **No decision required.**

### F2 — Two prefix bypasses are wider than the exact-match table

The exact-match table covers 5 routes. Six more paths skip the allowlist entirely (`server.ts:2422-2435`). Four are exact (`/mobile/ask`, `/mobile/search/relevant`, `/mobile/usage-report`, `/mobile/summaries`). Two are **prefix matches**:

```ts
isAssetFetch         = GET && pathname.startsWith("/mobile/asset/")
isConversationFetch  = GET && pathname.startsWith("/mobile/conversation/") && endsWith("/messages")
```

These forward an **arbitrary suffix** to the home proxy while attaching the gateway's `HOME_PROXY_TOKEN` (`server.ts:2448`). That is a wider forwarding surface than the exact-match allowlist grants — the token is the gateway's, so this is a confused-deputy shape: any authenticated device can make the gateway spend its own credential on any `/mobile/asset/*` path.

Not necessarily a hole — the home proxy may constrain what it serves under those prefixes. But **the allowlist is not what bounds it**, which is the opposite of what the module's name implies. *Flagged, not fixed*: determining whether the home proxy constrains the suffix requires reading `apps/proxy`-equivalent code that isn't in this repo.

> **Resolved (second pass): the home proxy does constrain both prefixes — the shape is not a hole, but the bound lives outside this repo.** Read at the sibling checkout:
> - `/mobile/asset/*` → `apps/proxy/src/server.ts:574-597`: the proxy takes only `url.pathname.split("/").pop()` as `assetId` and rebuilds `new URL("/asset/" + assetId, PIECES_BASE_URL)`. An arbitrary suffix cannot address any other PiecesOS path — worst case the ID is garbage and PiecesOS 404s.
> - `/mobile/conversation/*…/messages` → `server.ts:600-623`: the proxy takes `split("/")[3]` as `convoId` and rebuilds `/conversation/{id}/messages`.
>
> Residual (kept as a flag, low severity): the gateway attaches its `HOME_PROXY_TOKEN` to any such request before the proxy has proven it will constrain it — the trust boundary is "the proxy's parser", not "the allowlist". If the proxy's handlers ever widen, the gateway will spend its credential on the wider surface without any change here. Worth a comment at `server.ts:2422` pointing at the proxy's parse-then-rebuild contract; not worth a code change today. **Still flagged, severity lowered from "needs decision" to "coupling worth documenting".**

### F3 — The phone's pairing exchange has no route in this repo (new, second pass)

The mobile app pairs by POSTing `${baseUrl}/mobile/pair` (`apps/mobile/src/lib/pairing.ts:24`), and its own test hard-codes the gateway as the target: `expect(capturedUrl).toBe("http://127.0.0.1:8788/mobile/pair")` (`pairing.test.ts:41`). The QR flow in `Setup.tsx:374-383` calls it whenever the scanned payload carries a `pt_` token.

Verified absent on the daemon side:

- No `/mobile/pair` handler anywhere in `apps/daemon/src` (grep for `mobile/pair` → 0 matches; the full `url.pathname ===` route inventory has no such path).
- Not in the allowlist table either — so even if a handler existed, `findAllowedRoute("POST", "/mobile/pair")` → `undefined` → 404 at `server.ts:2437`.
- No `pt_` token is minted anywhere in this repo (grep for `pt_`/pairing-token minting → only the mobile parser). The minting and the exchange endpoint both live in the **sibling checkout**: `apps/pieces-gateway/src/pairing.ts:68` (`pt_${randomBytes(16)…}`) and `apps/pieces-gateway/src/server.ts:151`.

Consequence: a `pt_`-style QR scanned against **this** gateway fails — 401 (no JWT yet, auth runs at `server.ts:686` before any route dispatch) if it reaches auth, 404 if it somehow got past. Pairing still works end-to-end only when the QR targets the sibling `pieces-gateway`, or when the QR carries a pre-minted static token (no exchange). Whether that's intentional (pairing deliberately delegated to the sibling gateway / home proxy) or a porting gap is a **decision for Claude/the owner**: either add the route + allowlist entry here, or fix `Setup.tsx` to stop offering exchange against this gateway. **Flagged, not fixed.**

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
| F3 | Phone's `POST /mobile/pair` exchange has no route here; mint+endpoint live in sibling repo | **Needs decision** |
| F1 | `piecesPath` never read *in this repo* — resolved: sibling proxy consumes it (`:634`) | Resolved, no action |
| F2 | 2 prefix bypasses forward suffixes with gateway token — resolved: proxy parse-then-rebuild bounds them | Low, document coupling |
| 9 | The module's two copies have **already drifted** (5 routes vs 14) | **Needs decision** |
| 3 | `docs/ALLOWED_ROUTES.md` missing — provenance rule unverifiable | Process gap |
| 6 | 2 of 5 table routes never called by mobile | Dead config |
| 7 | Sole unchecked TypeScript in the workspace; no tests, no typecheck script | Coverage gap |
| 2 | Header comment cites `apps/proxy`/`apps/pieces-gateway` — they exist in the sibling repo, not here | Stale doc (corrected) |
| 1 | Plan's grep target (`@exocortex/allowlist`) matches nothing | Wrong doc |

**The deny-by-default gate itself works and is correctly ordered after auth.** The gaps are that its provenance artifact is missing, nothing tests it, the phone's pairing exchange has no route on this gateway, and the cross-repo copy of the module has drifted from this one.

## 9. Cross-repo evidence (second pass)

The module exists **twice**, which the header comment explicitly forbids ("Import this, do not copy it"):

| | This repo | Sibling checkout `pieces-android-shizuku-fix` |
|---|---|---|
| Path | `packages/allowlist/src/index.ts` | `packages/allowlist/src/index.ts` |
| Package name | `@pieces-android/allowlist` | `@pieces-android/allowlist` (identical) |
| Table entries | **5** (all GET) | **14** (5 GET + workstream variants + 2 POST create + `POST /mobile/pair`) |
| Consumers | `apps/daemon/src/server.ts:8` (`workspace:*`) | `apps/proxy/src/server.ts:6`, `apps/pieces-gateway/src/server.ts:6` (both `file:../../packages/allowlist`) |

Diff of the tables: the sibling copy is a strict **superset** — this repo's 5 entries appear verbatim; the extra 9 are `/mobile/workstream/*`, `/workstream/*`, `/workstream_events*` aliases, `POST /workstream_events/create` (×2 spellings), and `POST /mobile/pair`.

**The drift is currently benign but live.** The gateway forwards to the home proxy, and the home proxy re-gates every request against *its own* (14-entry) table — so any route present here is also present there, and no request can pass the gateway only to be rejected downstream for table reasons. The dangerous direction (a route added here but missing there → downstream 404 dressed up as success) cannot happen while this table stays a subset.

But nothing enforces the subset relation, and the two files have no shared provenance — the next edit to either copy can break it silently in either direction. This is the exact failure the header comment predicted, already in progress. **Recommendation for the owner: pick one** — (a) make the sibling repo consume this repo's package (git submodule / published workspace), (b) make this repo's gateway import nothing and treat the sibling table as the only table (delete this copy), or (c) add a CI check that diffs the two tables and fails if this one isn't a subset. A decision, not an agent guess — the repos have different deployment stories (LAN proxy vs. Docker gateway) and I can't judge which direction of unification the owner wants.

### Verification commands used (second pass)

```
git -C <sibling> log --oneline -- packages/allowlist      # independent history in both repos
grep -r "@pieces-android/allowlist" <sibling>             # proxy + pieces-gateway import it
diff the two ALLOWED_ROUTES arrays                        # this repo: 5 entries; sibling: 14 (superset)
grep -r "mobile/pair" apps/daemon/src                     # 0 matches — no handler on this gateway
grep -r "pt_" apps/{cli,desktop,mobile}/src               # only mobile's parser; no minter in this repo
grep -r "pt_\|pairingToken" <sibling>/apps/pieces-gateway # minter (pairing.ts:68) + handler (server.ts:151)
```

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
