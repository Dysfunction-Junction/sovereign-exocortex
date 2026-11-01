# Sensitivity migration evidence

`synthetic-v2-to-v3.json` records an executed migration of a synthetic v2 index:
six items and six chunks before and after, five classified by rules and one left
at the personal default. The password, 1040 and SSN default-clearance search
checks each returned zero hits. No live vault was accessed. The Phase 2 live
path `/mnt/databank/index/databank.db` is unavailable in this Windows checkout;
live migration counts and live red-flag searches remain unverified.

The matching migration fixture, rollback, backup and repeat-open assertions live
in `packages/databank/test/databank.test.ts`. Run them with:

```powershell
pnpm --filter @exocortex/databank test
```

## Applying and exporting a live receipt

`Databank.open()` automatically migrates a v2 index before returning. It creates
`index/databank.pre-v3-<timestamp>.db` using `VACUUM INTO`, then adds the column,
classifies all rows, records aggregate counts and advances the version in one
transaction. A failed backfill rolls back the column and version together. The
durable receipt is stored under `meta.sensitivity_migration_v3` in that same
transaction. No payloads, item IDs, names or paths are recorded in the receipt.

The CLI uses that same migration, without loading keys or models. A read-only
version check is the default; `--apply` migrates v2 or exports an existing v3
receipt. Run from the repo root, supplying absolute paths:

```powershell
pnpm --filter @exocortex/databank exec tsx migrate-sensitivity.ts --db <index.db> --evidence <receipt.json>
pnpm --filter @exocortex/databank exec tsx migrate-sensitivity.ts --db <index.db> --evidence <receipt.json> --apply
```

The report path must be new. If export fails after commit, rerunning with a new
report path exports the saved receipt without repeating the migration. Preserve
the backup and record live `Databank.search()` results for `password`, `1040`,
`ssn` and other applicable markers with default/personal clearance before
claiming the live coverage gate passed.

Section 5's explicit `DEFAULT 'personal'` takes precedence over section 4.1's
conflicting public default. Legacy backfill uses only title/path/source as
section 5 requires; new ingestion also checks extracted content. Legacy content
that has no identifying filename/path/source marker needs a later coverage
review. Public is available only through an explicit ingestion hint. The child
allowlist covers sources `youtube-kids`, `mana-youtube-kids`, `school-forms`, and
YouTube Kids/School Forms path segments (including beneath Mana).

Existing owner-test assertions remain, with private clearance requested for the
newly private Gwen Messenger fixture. Owner SQL is unchanged. HTTP owner tests
add an assertion that the default clearance excludes that fixture.

Deferred: direct item/blob ID access checks (must precede Phase 6), model-assisted
classification, therapy ingestion, and caller-side cloud/household policy.
Household/Bear-House callers must never pass `includeClinical` or `includeChild`.
