---
name: claude-advisor
description: Autonomously consults Claude Code and OpenAI Codex (as Chief Architect and Lead Reviewer) with automatic failover for architectural planning, tricky type inference, complex refactoring, and pre-commit diff review.
---

# Autonomous Multi-Advisor Bridge (Claude Pro + OpenAI Codex)

This skill enables Antigravity to consult Claude Code (`claude.exe`) and OpenAI Codex (`codex.exe`) as an autonomous advisory council without requiring user intervention. Both run on the user's existing subscriptions (Claude Pro and ChatGPT Plus/Team) with zero incremental API fees.

The bridge features **automatic high-availability failover**: if Claude Code reaches its 5-hour rolling session limit, requests are seamlessly and instantly routed to OpenAI Codex (`gpt-6-astra`), ensuring 100% advisory uptime.

Antigravity handles workspace execution, massive context ingestion (up to 2M tokens), test suite execution, and surgical file manipulation. The Advisory Council is consulted for high-leverage architectural reasoning and surgical verification.

## Autonomous Triggers (When Antigravity MUST Consult the Advisor)

Antigravity invokes this advisor **autonomously** under the following conditions:

1. **Pre-Commit / Pre-Completion Verification Gate:**
   - Before completing any non-trivial multi-file feature or bugfix, Antigravity captures `git diff` and pipes it to the advisor for rigorous review.
2. **Complex Architectural Dilemmas:**
   - Database schema redesigns, state machine transitions, cross-service boundary changes, or security-sensitive designs.
3. **Stubborn TypeScript or Runtime Bugs:**
   - If a compile or test error persists after one initial fix attempt, Antigravity extracts the minimal failing snippet + error and consults the advisor for the root-cause diagnosis.

## Usage Protocol

Execute via PowerShell:

### 1. Diff Review (Pre-Commit Gate)
```powershell
python $env:USERPROFILE\.agents\skills\claude-advisor\advisor.py "Reviewing changes for [feature name]" --mode review_diff --diff-file -
```
*(Or pass a path to a diff file)*

### 2. Architectural Consultation
```powershell
python $env:USERPROFILE\.agents\skills\claude-advisor\advisor.py "Should we use optimistic UI or server-confirmed state for this queue?" --mode architect --context "Relevant schema / interfaces here"
```

### 3. Stubborn Bug Diagnosis
```powershell
python $env:USERPROFILE\.agents\skills\claude-advisor\advisor.py "TypeError: Type 'string | undefined' is not assignable to type 'string'" --mode debug --context "Function definition and caller"
```

### 4. Competition Mode (Dual-Advisor Concurrent Adjudication)
```powershell
python $env:USERPROFILE\.agents\skills\claude-advisor\advisor.py "Reviewing changes for [feature name]" --mode review_diff --diff-file - --competition
python $env:USERPROFILE\.agents\skills\claude-advisor\advisor.py "Should we migrate to WebSocket or Server-Sent Events?" --mode architect --competition
```

### 5. Engine Override (Optional)
```powershell
python $env:USERPROFILE\.agents\skills\claude-advisor\advisor.py "..." --engine codex   # Force OpenAI Codex
python $env:USERPROFILE\.agents\skills\claude-advisor\advisor.py "..." --engine claude  # Force Claude Code
python $env:USERPROFILE\.agents\skills\claude-advisor\advisor.py "..." --engine ollama  # Any advisors.json name works
```

## Routing
When the Triad engine is importable (repo checkout, `~/.agents/triad`, or `TRIAD_ROOT`), `advisor.py` delegates
to `triad.advisor_manager` so it honours `advisors.json` priorities, structured failover and per-call telemetry -
identical behaviour to `triad review / consult / debug`. Without the engine it falls back to a built-in
Claude -> Codex bridge.

## Response Handling
Antigravity ingests the advisory council's feedback, adjusts the code or plan accordingly, applies edits with surgical precision, and verifies with the local test suite.
