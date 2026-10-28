## Row
<!-- Plan row number (docs/AGENT_QUEUE.md), e.g. 0.3 -->

## What changed
<!-- Files and behavior, in a few lines -->

## Evidence
<!-- Paste commands and output. CI must be green. -->

## Not verified
<!-- What you did not run or could not check -->

## Checklist
- [ ] One row, one PR; the row number is in the title
- [ ] Node 24; `pnpm typecheck` and the changed package's tests pass
- [ ] SHADOW still defaults on; no loosening of /network/delegate, approval, attestation or the event log
- [ ] If this touches the event schema, event log, replay, approvals or SHADOW: an Opus design review is linked
