# Spec: Sensitivity Tiers for the Databank

**Date:** 2026-11-01
**Author:** Claude (planning only — no implementation in this session; see `CLAUDE.md` root instructions)
**Status:** Draft, for Opus/Triad review before implementation
**Traces to:** `endzone_plan_ask_my_life.md` §2.4 (secrets in the index), §2.5 (other people's privacy), §2.6 (therapy recordings), §8 checklist item "No `secret` item is reachable by search or by any LLM"

## 1. Problem

The plan calls for four privacy tiers — `secret`, `private`, `clinical`, `child` — plus the already-shipped `gwen-knowledge-base` partition. None of the first four exist today. Concretely, per the plan's own audit:

- `Google_Passwords.pdf` / `.xlsx` were removed from the index in a one-off Phase 0 fix (`HERMES_PHASE0_EXECUTION_2026-11-01.md`), not via a reusable tier. The next credential file ingested (tax returns, insurance cards, paystubs — all named in §2.4) will not be caught automatically.
- Gwen's Messenger archive has a *partition* (`owner`), which is an identity axis ("whose data is this"), not a *sensitivity* axis ("how exposed should this be"). The two are orthogonal: Gwen's archive should likely also carry a `private` or stricter tier within her own partition.
- Intimate writings, kids' data (`child` tier), and therapy recordings (`clinical` tier, local-only, never to any cloud LLM) have zero mechanism today.

This is a real gap, not cosmetic: the daemon's `/api/chat` → Hermes Copilot path and any future `/ask` endpoint (Phase 6) both read through `Databank.search()`, and today that path has exactly one enforcement point (`filterSql`, see §3) — and it only knows about `owner`.

## 2. Why this must land before Phase 3 ships to users

Phase 3 (embeddings) and Phase 6 (`/ask`) both widen *recall*: semantic search surfaces items the user never typed a matching keyword for. Today that is a feature. Without sensitivity tiers it is also the mechanism that will eventually surface a credential document, a therapy session detail, or a child's data for an unrelated query — exactly the failure the plan's §2.5 "Intimate writing surfaced for an unrelated query" line already caught once by hand. Embeddings generalize that failure mode from "an unlucky keyword match" to "any semantically adjacent question." Ship the enforcement point before the blast radius grows.

## 3. Current enforcement point (don't replace it, extend it)

`packages/databank/databank.ts`, `filterSql()` (~line 422) is the single choke point used by both `ftsCandidates()` and `allowedChunks()` (and therefore both FTS and vector top-k). It already does owner-partition filtering:

```ts
private filterSql(o: SearchOptions): { where: string; args: Array<string | number> } {
  const parts: string[] = [`(CASE WHEN json_valid(i.meta) THEN
    CASE WHEN i.source = 'gwen-messenger' OR i.tier = 'gwen-knowledge-base'
      OR json_extract(i.meta, '$.tier') = 'gwen-knowledge-base' THEN 'gwen'
      ELSE COALESCE(NULLIF(json_extract(i.meta, '$.owner'), ''), 'michael') END
    ELSE NULL END) = ?`];
  const args: Array<string | number> = [o.owner ?? 'michael'];
  ...
}
```

This is the right place to add sensitivity filtering. It is **not** the right place to reuse the `tier` column — that column is already overloaded (`'hot'|'archived'` by schema CHECK, but `'gwen-knowledge-base'` is also written into it and matched via `OR i.tier = 'gwen-knowledge-base'`, bypassing the CHECK constraint silently because `tier` has no actual enum enforcement despite the SQL `CHECK` — see §4.1 for why this already matters).

## 4. Design

### 4.1 New column, not an overload of `tier`

Add a dedicated `sensitivity` column to `items`, separate from the existing storage-hotness `tier` column:

```sql
sensitivity TEXT NOT NULL DEFAULT 'public' CHECK (sensitivity IN ('public','personal','private','secret','clinical','child'))
```

Rationale: the plan (§2.4) actually specifies a 4-level base scale (`public`, `personal`, `private`, `secret`) plus two cross-cutting special cases (`clinical`, `child`) that have their own hard rules beyond "how exposed." Modeling all six as one CHECK-enforced enum is simpler than a bitmask or a second table, given the dataset size (low tens of thousands of items, not millions), and keeps the migration a single `ALTER TABLE` + backfill, matching the existing `migrate()` pattern at schema version 3.

Do **not** add a second meta-JSON fallback path the way `owner`/`gwen-knowledge-base` currently has (`i.tier = 'gwen-knowledge-base' OR json_extract(i.meta,'$.tier')='gwen-knowledge-base'`). That dual-path pattern is why the current `tier` column's CHECK constraint doesn't actually constrain anything in practice — a real column should be the single source of truth, written at ingest time, with `meta.sensitivity` (if ever present from an upstream parser) treated as an ingest-time *hint* that gets normalized into the real column, never read at query time.

### 4.2 Default-safe, not default-open

New column default is `'public'` for schema compatibility, but **ingest-time classification must run before the default is trusted**, not after. See §4.4. The gate gap is: between "column exists" and "classifier has run over existing rows," every legacy row reads as `public`. That is the opposite of fail-safe. The migration must therefore:

1. Add the column.
2. In the same migration transaction, run the baseline classifier (§4.4, rule-based pass only — no model call inside a schema migration) over all existing rows.
3. Only then consider the column live for query-time filtering.

This mirrors the pattern Phase 2's `execute_phase2_truth_repair.py` already used (backup via `VACUUM INTO`, single atomic transaction, before/after counts) — reuse that script's safety scaffolding rather than inventing new migration machinery.

### 4.3 Query-time enforcement

Extend `SearchOptions` and `filterSql()`:

```ts
export interface SearchOptions {
  owner?: string;
  minSensitivity?: never; // see note below — this is intentionally NOT exposed as "give me the private stuff"
  maxSensitivity?: 'public' | 'personal' | 'private'; // caller's clearance ceiling, default 'personal'
  includeClinical?: boolean; // explicit, separate flag — never implied by maxSensitivity
  includeChild?: boolean;    // explicit, separate flag — household apps never set this
  ...
}
```

Two deliberate design choices:

- **No single "sensitivity level" knob that goes all the way up.** `clinical` and `child` are not "more private than secret" — they are different *audiences* (you-only-reflecting, vs. never-this-household-app), not points on one dial. Modeling them as a linear scale would let a caller accidentally request `secret` and get `clinical` back because someone treated the enum as ordered. Keep the base 4-level scale ordered (`public < personal < private < secret`) for the "how exposed" axis, and keep `clinical`/`child` as orthogonal boolean gates that default closed and must be explicitly opened by a caller that has a reason to (the `/ask` endpoint's clinical-query path; never the household/Bear-House path).
- **`secret` is excluded even from `maxSensitivity`'s own scale — it never participates in normal retrieval at all**, per the plan's explicit rule ("removed from the text index and never returned to any LLM"). `secret` items should not even be reachable by raising `maxSensitivity`; they need a *separate* authenticated, logged, single-item retrieval path (if one is needed at all — the plan's own fix for Phase 0 was to remove the two credential files from the index outright, which may be sufficient and simpler than ever querying them again).

`filterSql()` becomes:

```ts
private filterSql(o: SearchOptions): { where: string; args: Array<string | number> } {
  const ceiling = o.maxSensitivity ?? 'personal';
  const levels = ['public', 'personal', 'private']; // secret is never in this list
  const allowed = levels.slice(0, levels.indexOf(ceiling) + 1);
  const parts: string[] = [
    /* existing owner-partition CASE expression, unchanged */,
    `i.sensitivity IN (${allowed.map(() => '?').join(',')})`,
  ];
  const args = [o.owner ?? 'michael', ...allowed];
  if (o.includeClinical) { parts[parts.length - 1] = `(${parts[parts.length - 1]} OR i.sensitivity = 'clinical')`; }
  if (o.includeChild) { /* same pattern */ }
  ...
}
```

(Shown as a sketch, not final SQL — the actual implementer should keep this inside the existing single `filterSql` function so `ftsCandidates` and `allowedChunks` cannot diverge, which is the property that makes this a real choke point today.)

### 4.4 Classification: rule-based first, model-assisted second, never model-only

Per source, in priority order:

| Source | Default sensitivity | Rule |
|---|---|---|
| `Google_Passwords.*`, any filename/title matching `password`, `passwd`, SSN/EIN patterns, tax-return markers (`1040`, `W-2`, `W-9`), insurance card OCR markers | `secret` | Filename/content regex, same approach as the already-shipped Phase 0 fix — generalize it into a standing rule table, not a one-off deletion |
| `source = 'gwen-messenger'` | `private` (in addition to existing `owner: gwen` partition) | Already-tagged source; just add the sensitivity value at the same backfill step that set `owner` |
| Therapy / Zoom Canvas content, once ingested | `clinical` | Ingest path is net-new (plan §2.6 — the recordings aren't located yet); whoever writes that ingester sets `sensitivity: 'clinical'` at `ingestText()` call time, never after the fact |
| Content under household-member-with-COPPA-relevance paths (plan names Mana's YouTube Kids history, school forms) | `child` | Source/path allowlist, set at ingest |
| Everything else | `personal` (not `public`) | `public` should be rare — reserve it for content the user would be fine surfacing in, e.g., a shared family export (plan §5 "family archive slice") |
| Model-assisted re-classification pass | — | Only as a *second pass* that can raise an item's tier (never lower it, never override a rule match), using the local llama.cpp model per the plan's §3 cost table — never a cloud model, since the pass necessarily reads personal content to classify it |

The model-assisted pass is explicitly **optional and secondary** — ship the rule-based pass alone first. It already covers every case the plan names by name. A model pass is worth adding later only if false negatives show up (content that should have been tiered up but matched no rule), and even then it should run locally per the plan's own cost/privacy table in §3.

### 4.5 Enforcement boundary: where does this actually get checked?

`filterSql()` protects `Databank.search()`. It does **not** protect:

- `GET /item/:id` and `GET /blob/:id` direct-by-ID access (the Phase 0 doc already notes these "retain the administrative access model" for the owner partition — the same caveat applies here: a caller with an item ID can bypass the sensitivity filter entirely today, for owner *and* would for sensitivity too, unless item/blob routes also check `sensitivity` before serving).
- Anything outside `packages/databank` that reads the SQLite file directly (scripts under `scripts/`, e.g. `execute_phase2_truth_repair.py`, which the plan's own Phase 4/5 work will likely extend).
- The eventual `/ask` endpoint (Phase 6) and any MCP tool (`databank.search`, `databank.ask`) built on top — these inherit whatever `Databank.search()` enforces *only if they call it with the right `maxSensitivity`/`includeClinical` values*. A caller that doesn't set `maxSensitivity` gets the safe default (`'personal'`), which is correct, but a caller that blindly sets `includeClinical: true` to "be thorough" defeats the whole point. This needs one sentence in the Phase 6 `/ask` spec, not a code change here: *the household/Bear-House integration must never pass `includeClinical` or `includeChild`, full stop, regardless of what the user asks for in a chat message.*

Item 1 (direct ID access) is the one gap in this spec that should block Phase 6, not ship after it — an `/ask` endpoint that retrieves by ID internally (e.g., to re-fetch a hit's full blob before quoting it) would otherwise silently bypass sensitivity filtering the same way it bypasses owner filtering today.

## 5. Migration plan (schema v2 → v3)

1. Extend `migrate()` in `databank.ts` with a `currentVersion < 3` branch, same pattern as the existing v1→v2 migration.
2. `ALTER TABLE items ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'personal' CHECK (...)` — note default `'personal'`, not `'public'`, so a migration that somehow runs the rule pass incompletely still fails closed-ish rather than open.
3. In the same transaction, run the rule table from §4.4 against all existing rows (filename/title/source matches only — no model call inside the migration).
4. Record counts (classified-by-rule vs. left-at-default) the same way Phase 2's script recorded its before/after counts, and write a `docs/evidence/sensitivity-tiers/` report — this is the receipt the plan's "coverage ledger rule" (§2.7) demands before trusting any filter that gates what a human or LLM can see.
5. Gate: re-run the plan's own test from §2 Red Flags — grep the live index for `password`, `1040`, `ssn` etc. and confirm zero matches return with `maxSensitivity: 'personal'` (default), the same shape as the Phase 0 "Live SQL verification" already done for the two named files, generalized.

## 6. Test plan

Mirror the existing test shape in `test/databank.test.ts` (which already tests the owner partition, per `HERMES_PHASE0_EXECUTION_2026-11-01.md`'s "Tests cover ... HTTP owner handling"):

- Default search (`maxSensitivity` unset) never returns `secret`, `clinical`, or `child` items, including via the vector path (not just FTS — the plan's own Phase 3 risk).
- `includeClinical`/`includeChild` are independently settable and don't leak into each other.
- A `private`-tier item (e.g. simulated Gwen content) is excluded when `owner` doesn't match, even if `maxSensitivity` would otherwise allow it — owner and sensitivity are AND'd, not OR'd.
- Rule-based classifier: feed it synthetic filenames matching each rule in §4.4's table (no real PII in test fixtures, matching the existing people-resolver test convention noted in the Phase 2 handoff).
- Regression: existing owner-partition tests still pass unchanged — this spec must not touch that logic, only add an independent AND'd clause.

## 7. Explicitly out of scope for this spec

- The `clinical` tier's "never sent to cloud LLM" rule (plan §2.6 rule 1) is a *caller discipline* rule, not something `filterSql` can enforce — the database doesn't know which process is about to read a result and hand it to which model. That has to be enforced at the call site (the future `/ask` endpoint and any MCP tool), as a code-review and architecture rule, documented here but implemented there. Flagging this explicitly so it isn't assumed "handled" once this spec ships.
- Actually locating and ingesting the therapy recordings (plan §2.6) — this spec only defines the tier they'd land in once ingested.
- The model-assisted classification pass (§4.4, bottom row) — explicitly deferred.
- Any UI/API surface for a user to manually re-tier an item after the fact (e.g., "mark this thread private") — reasonable future work, not blocking the plan's §8 checklist item.
