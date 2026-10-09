"""
Competition Mode: Concurrent Dual-Advisor Execution & Structured Synthesis.
Runs Claude Code and OpenAI Codex concurrently, synthesizes agreements,
isolated points, and contradictions, and logs full telemetry.
"""

import sys
import re
import json
import time
import hashlib
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any, Tuple, List, Optional

try:
    from triad.advisor_manager import query_configured_advisor, get_advisors, is_test_advisor, advisor_is_ready
    from triad.procutil import is_failed_advisor_response, strip_diff_bloat
    from triad.circuit import is_circuit_open
except ImportError:
    from advisor_manager import query_configured_advisor, get_advisors, is_test_advisor, advisor_is_ready
    from procutil import is_failed_advisor_response, strip_diff_bloat
    from circuit import is_circuit_open

# Ensure logs directory exists (fallback to user-writable directory in site-packages)
LOGS_DIR = Path.home() / ".agents" / "triad" / "logs"
try:
    _candidate = Path(__file__).resolve().parent / "logs"
    _candidate.mkdir(parents=True, exist_ok=True)
    LOGS_DIR = _candidate
except (OSError, PermissionError):
    try:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
COUNCIL_SESSIONS_LOG = LOGS_DIR / "council_sessions.jsonl"

DEFAULT_ADVISOR_PAIR: Tuple[str, str] = ("claude", "codex")
DEFAULT_LABELS = {"claude": "Claude Code", "codex": "OpenAI Codex"}


def hash_content(text: str) -> str:
    """Generate a hash of diff or prompt for session correlation (non-security use)."""
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:12]


def _ready_production_names() -> List[str]:
    names: List[str] = []
    for a in get_advisors(enabled_only=True, production_only=True):
        name = str(a.get("name") or "")
        if not name or is_circuit_open(name):
            continue
        ok, _ = advisor_is_ready(a)
        if ok:
            names.append(name)
    return names


def select_competition_pair(requested: Tuple[str, str] = DEFAULT_ADVISOR_PAIR) -> Tuple[Tuple[str, str], bool]:
    """
    Resolve which two advisors should compete.

    If both requested advisors are enabled they are used verbatim. Otherwise the two
    highest-priority enabled non-mock advisors are substituted so a disabled ``claude``
    or ``codex`` entry in advisors.json no longer silently degrades competition mode
    into two "advisor not found" errors.

    Open circuits and unreadiness (missing binary / closed port) are skipped so
    competition does not spend a full timeout on a known-dead advisor.

    Returns ``(pair, quorum_met)``; ``quorum_met`` is False when fewer than two
    non-mock advisors are enabled or ready.
    """
    if "mock" in requested:
        return requested, True

    enabled = [a for a in get_advisors(enabled_only=True) if not is_test_advisor(a)]
    enabled_names = [a.get("name", "") for a in enabled]
    if len(enabled_names) < 2:
        return requested, False

    ready_names = _ready_production_names()
    pair: List[str] = []
    for name in requested:
        if name in ready_names and name not in pair:
            pair.append(name)
    for name in ready_names:
        if len(pair) >= 2:
            break
        if name not in pair:
            pair.append(name)

    if len(pair) >= 2:
        return (pair[0], pair[1]), True
    return requested, False


def _label_for(name: str) -> str:
    if name in DEFAULT_LABELS:
        return DEFAULT_LABELS[name]
    for a in get_advisors():
        if a.get("name") == name:
            return a.get("display_name", name)
    return name


def _fence(t: str) -> str:
    """Generate dynamic markdown fence that cannot be broken out of by inner backticks."""
    text = str(t or "")
    runs = [len(m) for m in re.findall(r"`+", text)] if text else []
    f = "`" * (max(runs + [2]) + 1)
    return f"{f}\n{text}\n{f}"


def build_synthesis_prompt(
    prompt: str,
    claude_resp: str,
    codex_resp: str,
    context: str = None,
    diff: str = None,
    adv1_label: str = "Claude Code",
    adv2_label: str = "OpenAI Codex",
) -> str:
    """Constructs rigorous 4-part synthesis prompt with breakout-resistant fencing."""
    return (
        "You are the Chief Adjudicator of an elite Multi-Agent Advisory Council.\n"
        "Two independent premier AI models evaluated the same task. Your goal is NOT to average their answers, "
        "but to conduct a rigorous, evidence-based adjudication.\n\n"
        f"ORIGINAL TASK / QUERY:\n{prompt}\n\n"
        + (f"DIFF:\n{_fence(diff)}\n\n" if diff else "")
        + (f"CONTEXT:\n{_fence(context)}\n\n" if context else "")
        + f"--- ADVISOR 1 ({adv1_label}) REVIEW ---\n{_fence(claude_resp)}\n\n"
        f"--- ADVISOR 2 ({adv2_label}) REVIEW ---\n{_fence(codex_resp)}\n\n"
        "Provide your adjudication in exactly these 4 structured sections:\n"
        "### 1. Points of Unanimous Agreement\n"
        "List all high-confidence findings, approvals, or bugs that BOTH advisors independently caught.\n\n"
        "### 2. Points Raised by Only One Advisor\n"
        "Itemize points raised by only one model. Adjudicate each: is it genuinely valid, a false positive, or speculative?\n\n"
        "### 3. Direct Contradictions\n"
        "Identify anywhere the advisors directly contradicted each other on facts, types, or correctness. If none, explicitly write 'None'.\n\n"
        "### 4. Final Adjudicated Verdict & Action Plan\n"
        "Give the single authoritative verdict. State which advisor's reasoning was more accurate and why, with the definitive fix/recommendation."
    )


def build_adversarial_synthesis_prompt(
    prompt: str,
    blue_resp: str,
    red_resp: str,
    context: str = None,
    diff: str = None,
    blue_label: str = "Blue Team",
    red_label: str = "Red Team",
) -> str:
    """Constructs adversarial referee prompt adjudicating Generator (Blue) vs Adversary (Red) with dynamic fencing."""
    return (
        "You are the Chief Security Referee of the Triad Adversarial Arena.\n"
        "Blue Team drafted the proposed solution. Red Team conducted an aggressive adversarial attack "
        "to find race conditions, unhandled edge cases, security regressions, or generate failing tests.\n\n"
        f"TARGET TASK / CODE:\n{prompt}\n\n"
        + (f"DIFF:\n{_fence(diff)}\n\n" if diff else "")
        + (f"CONTEXT:\n{_fence(context)}\n\n" if context else "")
        + f"--- BLUE TEAM PROPOSAL ({blue_label}) ---\n{_fence(blue_resp)}\n\n"
        f"--- RED TEAM ATTACK AUDIT ({red_label}) ---\n{_fence(red_resp)}\n\n"
        "Deliver your authoritative verdict in exactly 4 sections:\n"
        "### 1. Red Team Attack Surface & Break Vectors\n"
        "Itemize each failure mode, race condition, or exploit claimed by Red Team.\n\n"
        "### 2. Validity of Break Attempts\n"
        "Which of Red Team's attacks successfully broke the code? Which were false positives or mitigated?\n\n"
        "### 3. Adversarial Arena Verdict\n"
        "State 'VERDICT: RESILIENT' (if Blue Team holds against attacks) or 'VERDICT: VULNERABLE' (if broken).\n\n"
        "### 4. Hardened Patch & Action Items\n"
        "Provide the final, fully-hardened implementation incorporating fixes for all valid Red Team findings."
    )


def parse_adversarial_verdict(synthesis: str) -> Optional[str]:
    """
    Parses the final authoritative adversarial verdict from Chief Security Referee synthesis.
    Strips code blocks (backticks, tildes, indented code) and quotes to prevent spoofing.
    Strictly requires an authoritative Section 3 (Adversarial Arena Verdict) and a standalone
    verdict declaration. Returns 'RESILIENT', 'VULNERABLE', or None if ambiguous, missing, or conflicting.
    """
    if not synthesis:
        return None

    # 1. Line-based scanner tracking opening delimiter character and length
    lines = synthesis.splitlines()
    out = []
    fence_char = None
    fence_len = 0

    for line in lines:
        stripped = line.strip()
        m = re.match(r"^[ ]{0,3}(`{3,}|~{3,})", line)
        if fence_char is None:
            if m:
                delimiter = m.group(1)
                fence_char = delimiter[0]
                fence_len = len(delimiter)
                continue
            # Strip blockquotes (> ...)
            if stripped.startswith(">"):
                continue
            # Strip indented code blocks (4 spaces or tab at start of line)
            if line.startswith("    ") or line.startswith("\t"):
                continue
            out.append(line)
        else:
            # Inside code fence: check for matching closing fence
            if m:
                delimiter = m.group(1)
                if delimiter[0] == fence_char and len(delimiter) >= fence_len:
                    rest = line[m.end():].strip()
                    if not rest:
                        fence_char = None
                        fence_len = 0
            continue

    cleaned = "\n".join(out)

    # 2. Strictly require exactly one authoritative Section 3
    sec_pattern = re.compile(r"(?im)^###\s*3\.?\s*(?:Adversarial Arena )?Verdict\b[\s\S]*?(?=^###\s*4|\Z)")
    sec_matches = list(sec_pattern.finditer(cleaned))
    if len(sec_matches) != 1:
        return None
    target_text = sec_matches[0].group(0)

    # 3. Find standalone verdict declaration lines
    pattern = re.compile(
        r"(?im)^\s*(?:[-*\u2022]\s*)?(?:\*{0,2}|_{0,2}|`{0,2})VERDICT\s*:\s*(?:\*{0,2}|_{0,2}|`{0,2})(RESILIENT|VULNERABLE)\b(?:\*{0,2}|_{0,2}|`{0,2})\s*[\.!]?\s*$"
    )
    matches = pattern.findall(target_text)
    unique_verdicts = set(m.upper() for m in matches)
    if len(unique_verdicts) != 1:
        return None
    candidate = unique_verdicts.pop()

    # Reject if conflicting verdict declaration appears anywhere in cleaned text
    any_verdict_pat = re.compile(r"\bVERDICT\s*:\s*(RESILIENT|VULNERABLE)\b", re.IGNORECASE)
    all_verdicts = set(m.upper() for m in any_verdict_pat.findall(cleaned))
    if len(all_verdicts) > 1:
        return None

    return candidate


def query_competition_council(
    prompt: str,
    context: str = None,
    diff: str = None,
    mode: str = "review_diff",
    timeout: int = 120,
    advisor_names: Tuple[str, str] = ("claude", "codex"),
    adversarial: bool = False,
) -> Dict[str, Any]:
    """
    Executes two advisors and synthesizes their assessments.
    When adversarial=True, Advisor 1 plays Blue Team (Generator), its output is fed to
    Advisor 2 playing Red Team (Adversary/Breaker), and the Chief Security Referee adjudicates.
    Returns structured session dictionary containing raw outputs, synthesis, status, and verdict.
    """
    start_time = time.time()
    start_mono = time.monotonic()
    deadline = start_mono + timeout

    def _rem_timeout() -> int:
        return int(deadline - time.monotonic())

    if isinstance(prompt, list):
        prompt = " ".join(prompt).strip()
    if isinstance(diff, list):
        diff = "\n".join(diff)
    prompt = str(prompt or "")
    diff = strip_diff_bloat(str(diff or ""))

    results = {}

    # Resolve the competing pair against the live config (quorum + substitution)
    (adv1_name, adv2_name), quorum_met = select_competition_pair(tuple(advisor_names))
    if not quorum_met:
        ready_names = _ready_production_names()
        print(f"[Triad Competition Mode Warning] Fewer than 2 ready non-mock advisors ({len(ready_names)} ready). Falling back to single advisor.")
        single_name = ready_names[0] if ready_names else "auto"
        rem_single = _rem_timeout()
        if rem_single <= 0:
            single_resp = "[Error: Timeout budget exhausted before execution]"
        else:
            single_resp = query_configured_advisor(single_name, prompt, context=context, diff=diff, mode=mode, timeout=rem_single)
        is_fail = is_failed_advisor_response(single_resp)
        return {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "mode": mode,
            "content_hash": hash_content((diff or "") + (prompt or "")),
            "advisors": [single_name] if single_name != "auto" else [],
            "responses": {single_name: single_resp} if single_name != "auto" else {},
            "synthesis": single_resp,
            "elapsed_seconds": round(time.time() - start_time, 2),
            "quorum_met": False,
            "adversarial": adversarial,
            "status": "error" if is_fail else "degraded",
            "verdict": None,
        }
    if (adv1_name, adv2_name) != tuple(advisor_names):
        print(f"[Triad Competition Mode] Requested pair {advisor_names} not fully enabled; competing with ({adv1_name}, {adv2_name}).")

    if adversarial:
        # Sequential Blue -> Red: Blue Team generates proposal/defense
        rem1 = _rem_timeout()
        if rem1 <= 0:
            return {
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                "mode": mode,
                "content_hash": hash_content((diff or "") + (prompt or "")),
                "advisors": [adv1_name, adv2_name],
                "responses": {},
                "synthesis": "[Competition Error] Timeout budget exhausted before Blue Team execution",
                "elapsed_seconds": round(time.time() - start_time, 2),
                "quorum_met": False,
                "adversarial": True,
                "status": "error",
                "verdict": None,
            }

        p1 = f"[ROLE: BLUE TEAM - GENERATOR & ARCHITECT]\nTask: {prompt}\nProvide the most resilient, optimal solution/review."
        try:
            resp1 = query_configured_advisor(adv1_name, p1, context=context, diff=diff, mode=mode, timeout=rem1)
        except Exception as e:
            resp1 = f"[Error from {adv1_name}: {e}]"

        # If Blue Team generation fails, do not run Red Team attack on error string
        if is_failed_advisor_response(resp1):
            elapsed = time.time() - start_time
            return {
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                "mode": mode,
                "content_hash": hash_content((diff or "") + (prompt or "")),
                "advisors": [adv1_name, adv2_name],
                "responses": {adv1_name: resp1},
                "synthesis": f"[Adversarial Error] Blue Team generation failed: {resp1}",
                "elapsed_seconds": round(elapsed, 2),
                "quorum_met": False,
                "adversarial": True,
                "status": "error",
                "verdict": None,
            }

        rem2 = _rem_timeout()
        if rem2 <= 0:
            resp2 = f"[Error from {adv2_name}: Timeout budget exhausted before Red Team execution]"
        else:
            p2 = (
                f"[ROLE: RED TEAM - ADVERSARY & SECURITY BREAKER]\n"
                f"Task: {prompt}\n\n"
                f"--- BLUE TEAM PROPOSAL UNDER ATTACK ---\n{_fence(resp1)}\n\n"
                f"Aggressively attack and break this code/proposal: identify race conditions, memory leaks, boundary flaws, or failing tests."
            )
            try:
                resp2 = query_configured_advisor(adv2_name, p2, context=context, diff=diff, mode=mode, timeout=rem2)
            except Exception as e:
                resp2 = f"[Error from {adv2_name}: {e}]"
    else:
        # Concurrent evaluation
        rem_concurrent = _rem_timeout()
        if rem_concurrent <= 0:
            resp1 = f"[Error from {adv1_name}: Timeout budget exhausted]"
            resp2 = f"[Error from {adv2_name}: Timeout budget exhausted]"
        else:
            with ThreadPoolExecutor(max_workers=2) as executor:
                future_adv1 = executor.submit(
                    query_configured_advisor,
                    adv1_name,
                    prompt,
                    context=context,
                    diff=diff,
                    mode=mode,
                    timeout=rem_concurrent
                )
                future_adv2 = executor.submit(
                    query_configured_advisor,
                    adv2_name,
                    prompt,
                    context=context,
                    diff=diff,
                    mode=mode,
                    timeout=rem_concurrent
                )

                try:
                    resp1 = future_adv1.result()
                except Exception as e:
                    resp1 = f"[Error from {adv1_name}: {e}]"

                try:
                    resp2 = future_adv2.result()
                except Exception as e:
                    resp2 = f"[Error from {adv2_name}: {e}]"

    key1 = adv1_name
    key2 = adv2_name if adv2_name != adv1_name else f"{adv2_name}_2"
    results[key1] = resp1
    results[key2] = resp2

    failed1 = is_failed_advisor_response(resp1)
    failed2 = is_failed_advisor_response(resp2)

    # 2. Synthesize using a *successful* advisor. If both reviews failed, do not
    #    burn another full timeout synthesizing two error strings.
    # Synthesis uses the remaining timeout budget, clamped between 30s and 90s
    rem_synth = _rem_timeout()
    synth_timeout = max(min(rem_synth if rem_synth > 0 else timeout, 90), 30)
    if failed1 and failed2:
        synthesis = (
            f"[Competition Error] Both advisors failed; skipping synthesis.\n"
            f"{adv1_name}: {resp1}\n{adv2_name}: {resp2}"
        )
    else:
        if adversarial:
            # Blue never judges itself. If both mock requested, use mock; otherwise prefer an independent 3rd ready advisor; fallback to Red
            if adv1_name == adv2_name == "mock":
                synth_engine = "mock"
            else:
                third = next((n for n in _ready_production_names() if n not in (adv1_name, adv2_name)), None)
                synth_engine = third or (adv2_name if not failed2 else adv1_name)
            synth_prompt = build_adversarial_synthesis_prompt(
                prompt, resp1, resp2, context=context, diff=diff,
                blue_label=f"Blue Team ({_label_for(adv1_name)})",
                red_label=f"Red Team ({_label_for(adv2_name)})",
            )
        else:
            synth_engine = adv2_name if failed1 and not failed2 else adv1_name
            synth_prompt = build_synthesis_prompt(
                prompt, resp1, resp2, context=context, diff=diff,
                adv1_label=_label_for(adv1_name), adv2_label=_label_for(adv2_name),
            )
        synthesis = query_configured_advisor(synth_engine, synth_prompt, mode="general", timeout=synth_timeout)
        if is_failed_advisor_response(synthesis):
            other = adv1_name if synth_engine == adv2_name else adv2_name
            synthesis = query_configured_advisor(other, synth_prompt, mode="general", timeout=synth_timeout)

    elapsed = time.time() - start_time
    is_synth_failed = is_failed_advisor_response(synthesis)
    if (failed1 and failed2) or is_synth_failed:
        status = "error"
    elif failed1 or failed2:
        status = "degraded"
    else:
        status = "ok"

    effective_quorum = quorum_met and (not failed1) and (not failed2) and (not is_synth_failed)
    verdict = None
    if adversarial:
        if status == "ok":
            verdict = parse_adversarial_verdict(synthesis)

    session_data = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "mode": mode,
        "content_hash": hash_content((diff or "") + (prompt or "")),
        "advisors": [adv1_name, adv2_name],
        "responses": {
            key1: resp1,
            key2: resp2
        },
        "synthesis": synthesis,
        "elapsed_seconds": round(elapsed, 2),
        "quorum_met": effective_quorum,
        "adversarial": adversarial,
        "status": status,
        "verdict": verdict,
    }

    # 3. Log to telemetry file
    try:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        with open(COUNCIL_SESSIONS_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(session_data) + "\n")
    except Exception as e:
        print(f"[Warning: Failed to log council session: {e}]", file=sys.stderr)

    return session_data
