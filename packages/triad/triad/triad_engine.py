#!/usr/bin/env python3
"""
Autonomous Multi-Agent Triad Engine (triad_engine.py).
Unified Executive Orchestrator & Advisory Bridge:
- Antigravity: Executive Engine, Massive 2M Context, Code Writer & Test Runner
- Advisory Council: Claude 3.7 Sonnet (Claude Pro) with zero-downtime failover to OpenAI Codex (gpt-6-astra via ChatGPT Plus)
- Hermes Agent: Android Phone Automation & Skill Specialist
- Ground Truth Gates: Local TypeScript (tsc) and Vitest/Jest test suites
- 100% Zero-Incremental-Cost Policy: Flat-rate subscriptions only ($0 extra per-token billing)
"""

import sys
import os
import stat
import re
import subprocess
import argparse
import json
import tempfile
import shutil
import uuid
import time
import hashlib
import ast
import contextlib
from functools import lru_cache
from pathlib import Path
from typing import List, Tuple, Optional, Dict, Any, Union, Set

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

TRIAD_DIR = Path(__file__).resolve().parent
EMPTY_MCP = TRIAD_DIR / "empty-mcp.json"

try:
    from triad.paths import (
        CLAUDE_PATH, CODEX_PATH, AGY_PATH, HERMES_PATH, CODEX_AUTH,
        PORT_HERMES_RELAY, PORT_PIECES_OS, PORT_OLLAMA, PORT_TRIAD_SERVER,
        AGENT_MESH_DIR, AGENT_MESH_SERVER,
    )
    from triad.procutil import (
        kill_process_tree, is_port_open, classify_advisor_response,
        strip_diff_bloat, is_doc_or_asset_file,
    )
    from triad.circuit import snapshot_circuits, is_circuit_open, reset_circuit
    from triad.advisor_manager import query_configured_advisor, get_advisors, advisor_is_ready
    from triad.worktree import create_worktree, remove_worktree, isolated_worktree, list_worktrees, prune_worktrees, get_repo_root, clean_git_env, provision_worktree_dependencies, capture_directory_snapshot, get_provisioned_manifest_entries, is_reparse_or_link
    from triad.competition import query_competition_council
    from triad.intent_engine import classify_intent, execute_intent
except ImportError:
    from paths import (
        CLAUDE_PATH, CODEX_PATH, AGY_PATH, HERMES_PATH, CODEX_AUTH,
        PORT_HERMES_RELAY, PORT_PIECES_OS, PORT_OLLAMA, PORT_TRIAD_SERVER,
        AGENT_MESH_DIR, AGENT_MESH_SERVER,
    )
    from procutil import (
        kill_process_tree, is_port_open, classify_advisor_response,
        strip_diff_bloat, is_doc_or_asset_file,
    )
    from circuit import snapshot_circuits, is_circuit_open, reset_circuit
    from advisor_manager import query_configured_advisor, get_advisors, advisor_is_ready
    from worktree import create_worktree, remove_worktree, isolated_worktree, list_worktrees, prune_worktrees, get_repo_root, clean_git_env, provision_worktree_dependencies, capture_directory_snapshot, get_provisioned_manifest_entries, is_reparse_or_link
    from competition import query_competition_council
    from intent_engine import classify_intent, execute_intent

try:
    from triad.notifier import notify_event
except Exception:
    try:
        from notifier import notify_event
    except Exception:
        def notify_event(*args, **kwargs):
            return False

# Node toolchain launchers: on Windows the npm-provided shims are .cmd files which
# CreateProcess will not execute without the extension.
NPX_CMD = "npx.cmd" if os.name == "nt" else "npx"
NPM_CMD = "npm.cmd" if os.name == "nt" else "npm"

def query_claude(prompt: str, context: str = None, diff: str = None, mode: str = "general", timeout: int = 120, track_circuit: bool = True) -> str:
    """Query Claude advisor via configured advisor manager."""
    return query_configured_advisor("claude", prompt, context=context, diff=diff, mode=mode, timeout=timeout, track_circuit=track_circuit)

def query_codex(prompt: str, context: str = None, diff: str = None, mode: str = "general", timeout: int = 120, track_circuit: bool = True) -> str:
    """Query OpenAI Codex advisor via configured advisor manager."""
    return query_configured_advisor("codex", prompt, context=context, diff=diff, mode=mode, timeout=timeout, track_circuit=track_circuit)

def query_advisory_council(prompt: str, context: str = None, diff: str = None, mode: str = "general", engine: str = "auto", timeout: int = 180, track_circuit: bool = True) -> str:
    """
    Autonomous Advisory Council with zero-downtime failover and dynamic advisor routing:
    Delegates to configured advisors via advisor_manager.
    """
    target = "claude" if engine == "bare_single" else engine
    return query_configured_advisor(target, prompt, context=context, diff=diff, mode=mode, timeout=timeout, track_circuit=track_circuit)

def get_git_diff(cached: bool = False, head: bool = False, env: Optional[Dict[str, str]] = None, cwd: Optional[Path] = None, binary: bool = False) -> str:
    """
    Retrieve git diff from current repository, bypassing external diff drivers and textconv filters.

    ``cached`` -> staged changes vs HEAD; ``head`` -> the most recent commit (HEAD~1..HEAD),
    *not* the working tree against HEAD~1 - that would silently fold uncommitted edits into a
    "review the last commit" request.
    """
    cmd = ["git", "diff", "--no-color", "--no-ext-diff", "--no-textconv"]
    if binary:
        cmd.append("--binary")
    if cached:
        cmd.append("--cached")
    elif head:
        cmd.extend(["HEAD~1", "HEAD"])

    # Only sanitize Git env when crossing into ephemeral worktrees or explicitly requested.
    # Preserve caller env (including alternate GIT_INDEX_FILE) for direct workspace operations.
    exec_env = dict(os.environ if env is None else env)
    target_cwd = cwd or Path.cwd()

    res = subprocess.run(
        cmd,
        cwd=str(target_cwd),
        env=exec_env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace"
    )
    if res.returncode != 0:
        raise RuntimeError(f"git diff failed (exit code {res.returncode}): {res.stderr.strip() or res.stdout.strip()}")
    return res.stdout.strip()

def _decode_codex_auth(auth_path: Path) -> Dict[str, Any]:
    """
    Inspect the Codex OAuth cache without touching the network. Returns plan metadata
    and a computed ``status`` of ``active`` / ``expired`` / ``unknown`` / ``missing``.
    """
    info: Dict[str, Any] = {"status": "missing", "plan": None, "active_until": None}
    if not auth_path.exists():
        return info
    try:
        import base64
        from datetime import datetime, timezone
        with open(auth_path, "r", encoding="utf-8") as f:
            auth_data = json.load(f)
        id_token = (auth_data.get("tokens") or {}).get("id_token", "")
        info["status"] = "unknown"
        parts = id_token.split(".") if id_token else []
        if len(parts) >= 2:
            padded = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8", errors="replace"))
            auth_meta = payload.get("https://api.openai.com/auth", {})
            info["plan"] = auth_meta.get("chatgpt_plan_type")
            until_raw = auth_meta.get("chatgpt_subscription_active_until")
            if until_raw:
                info["active_until"] = str(until_raw)[:10]
                try:
                    until_dt = datetime.fromisoformat(str(until_raw).replace("Z", "+00:00"))
                    if until_dt.tzinfo is None:
                        until_dt = until_dt.replace(tzinfo=timezone.utc)
                    info["status"] = "active" if until_dt >= datetime.now(timezone.utc) else "expired"
                except ValueError:
                    info["status"] = "unknown"
    except Exception as e:
        info["status"] = "unknown"
        info["error"] = str(e)
    return info


def collect_doctor_report(probe_advisors: bool = True, claude_probe_timeout: int = 15) -> Dict[str, Any]:
    """
    Gather the health of every Triad layer as structured data (no printing).

    ``probe_advisors=False`` skips the live Claude round-trip, which otherwise spends a
    Claude Pro turn on every ``triad doctor`` run.
    """
    advisors = get_advisors()
    by_name = {a.get("name"): a for a in advisors}

    # 1. Antigravity
    agy = {"binary": str(AGY_PATH), "present": AGY_PATH.exists()}

    # 2. Claude Code
    claude_cfg = by_name.get("claude", {})
    claude_ready, _ = advisor_is_ready(claude_cfg) if claude_cfg else (False, "")
    claude_bin = str(claude_cfg.get("binary_path") or CLAUDE_PATH)
    claude = {
        "binary": claude_bin,
        "present": claude_ready or CLAUDE_PATH.exists(),
        "enabled": bool(claude_cfg.get("enabled", False)),
        "probe": "skipped",
        "probe_detail": "",
    }
    if probe_advisors and claude["present"] and claude["enabled"]:
        resp = query_claude("Respond with OK", timeout=claude_probe_timeout, track_circuit=False)
        kind = classify_advisor_response(resp)
        if kind == "limit":
            claude["probe"] = "limit"
        elif kind == "ok" and "OK" in resp:
            claude["probe"] = "online"
        else:
            claude["probe"] = "error"
        claude["probe_detail"] = resp.strip()[:160]
    elif not claude["present"]:
        claude["probe"] = "missing"

    # 3. Codex
    codex_cfg = by_name.get("codex", {})
    codex_ready, _ = advisor_is_ready(codex_cfg) if codex_cfg else (False, "")
    codex_bin = str(codex_cfg.get("binary_path") or CODEX_PATH)
    codex = {
        "binary": codex_bin,
        "present": codex_ready or CODEX_PATH.exists(),
        "enabled": bool(codex_cfg.get("enabled", False)),
        "auth_file": str(CODEX_AUTH),
    }
    codex.update(_decode_codex_auth(CODEX_AUTH))
    codex_has_key = bool(
        os.environ.get("OPENAI_API_KEY", "").strip()
        or os.environ.get("CODEX_API_KEY", "").strip()
        or (codex_cfg.get("env") or {}).get("OPENAI_API_KEY")
        or (codex_cfg.get("env") or {}).get("CODEX_API_KEY")
    )
    codex["has_api_key"] = codex_has_key

    # 4. Hermes / Nous
    nous_authed = False
    general_cascade: List[str] = []
    nous_error = ""
    try:
        try:
            from triad.nous_bridge import get_nous_token, TASK_MODEL_CASCADES
        except ImportError:
            from nous_bridge import get_nous_token, TASK_MODEL_CASCADES
        nous_authed = bool(get_nous_token())
        general_cascade = list(TASK_MODEL_CASCADES.get("general", []))
    except Exception as e:
        nous_error = str(e)
    nous_cfg = by_name.get("nous", {})
    hermes = {
        "binary": str(HERMES_PATH),
        "present": HERMES_PATH.exists(),
        "nous_authed": nous_authed,
        "nous_enabled": bool(nous_cfg.get("enabled", False)),
        "nous_priority": nous_cfg.get("priority"),
        "nous_lead_model": general_cascade[0] if general_cascade else None,
        "nous_error": nous_error,
        "relay_port": PORT_HERMES_RELAY,
        "relay_listening": is_port_open("127.0.0.1", PORT_HERMES_RELAY),
    }

    # 5. Local subsystems
    local = {
        "pieces_os": {"port": PORT_PIECES_OS, "online": is_port_open("127.0.0.1", PORT_PIECES_OS)},
        "ollama": {"port": PORT_OLLAMA, "online": is_port_open("127.0.0.1", PORT_OLLAMA)},
        "triad_server": {"port": PORT_TRIAD_SERVER, "online": is_port_open("127.0.0.1", PORT_TRIAD_SERVER)},
    }

    circuits = snapshot_circuits()
    open_circuits = {
        name for name, entry in (circuits.get("advisors") or {}).items()
        if isinstance(entry, dict) and entry.get("state") == "open"
    }

    # Aggregate: the council is healthy if at least one enabled advisor is usable
    # and not sitting behind an open circuit.
    usable: List[str] = []
    prod_advisors = get_advisors(enabled_only=True, production_only=True)
    for adv in prod_advisors:
        name = str(adv.get("name") or "")
        if not name or name in open_circuits or is_circuit_open(name):
            continue
        ready, _ = advisor_is_ready(adv)
        if not ready:
            continue
        if name == "claude" and claude["probe"] in ("error", "limit", "missing"):
            continue
        if name == "codex":
            # Only exclude codex if definitely expired and has no api key, or missing auth and has no api key
            if codex["status"] == "expired" and not codex["has_api_key"]:
                continue
            if codex["status"] == "missing" and not codex["has_api_key"]:
                continue
        if name == "nous" and not hermes["nous_authed"]:
            continue
        usable.append(name)

    warnings: List[str] = []
    if claude["probe"] == "limit" or is_circuit_open("claude"):
        warnings.append("Claude Code is at its session limit; failover to the next advisor is armed.")
    if claude["probe"] == "error":
        warnings.append(f"Claude Code probe failed: {claude['probe_detail']}")
    if codex["enabled"] and codex["status"] == "expired" and not codex["has_api_key"]:
        warnings.append(f"Codex ChatGPT subscription appears expired (active until {codex['active_until']}).")
    if codex["enabled"] and codex["status"] == "missing" and not codex["has_api_key"]:
        warnings.append(f"Codex auth cache not found at {CODEX_AUTH}; run 'codex login' or set OPENAI_API_KEY.")
    if codex["enabled"] and codex["status"] == "unknown" and not codex["has_api_key"]:
        warnings.append("Codex authentication is unverified; operating with session cache.")
    if hermes["nous_enabled"] and not hermes["nous_authed"]:
        warnings.append("Nous advisor is enabled but no NOUS_API_KEY / Hermes auth.json token was found.")
    for name, entry in (circuits.get("advisors") or {}).items():
        if isinstance(entry, dict) and entry.get("state") == "open":
            rem = entry.get("remaining_seconds", 0)
            warnings.append(f"Advisor '{name}' circuit is open ({entry.get('reason')}, {rem}s remaining).")

    return {
        "healthy": bool(usable),
        "usable_advisors": usable,
        "warnings": warnings,
        "antigravity": agy,
        "claude": claude,
        "codex": codex,
        "hermes": hermes,
        "local": local,
        "circuits": circuits,
    }


def _render_doctor_report(report: Dict[str, Any]) -> None:
    def flag(ok: bool, yes: str = "OK", no: str = "MISSING") -> str:
        return yes if ok else no

    print("================================================================================")
    print("           AUTONOMOUS MULTI-AGENT TRIAD: SYSTEM HEALTH & COST AUDIT              ")
    print("================================================================================")
    print("Policy: STRICT ZERO INCREMENTAL COST (Flat-rate subscriptions & local execution)\n")

    agy = report["antigravity"]
    print("[1] Antigravity (Executive Engine & Context Shield)")
    print(f"    - Binary:       {agy['binary']} ({flag(agy['present'])})")
    print("    - Context:      Up to 2,000,000 tokens")
    print("    - Billing:      $0 extra (Included in Antigravity IDE access)")

    c = report["claude"]
    print("\n[2] Claude Code (Chief Architect & Diff Verifier)")
    print(f"    - Binary:       {c['binary']} ({flag(c['present'])})")
    print(f"    - Subscription: Claude Pro (Flat-rate, $0 extra API cost) | advisors.json enabled={c['enabled']}")
    probe_text = {
        "online": "ONLINE & READY",
        "limit": "PAUSED [Session Limit Hit] -> Auto-Failover armed",
        "error": f"ERROR ({c['probe_detail']})",
        "skipped": "NOT PROBED (--quick)",
        "missing": "BINARY NOT FOUND",
    }.get(c["probe"], c["probe"])
    print(f"    - Status:       {probe_text}")

    x = report["codex"]
    print("\n[3] OpenAI Codex (High-Availability Failover Advisor)")
    print(f"    - Binary:       {x['binary']} ({flag(x['present'])})")
    if x["status"] == "missing":
        print(f"    - Status:       Auth config not found at {x['auth_file']}")
    else:
        plan = (x.get("plan") or "plus").capitalize()
        until = x.get("active_until") or "unknown"
        print(f"    - Plan:         ChatGPT {plan} (active until {until})")
        print("    - Mode:         chatgpt OAuth via WebSockets")
        print("    - Billing:      $0 extra (Included in ChatGPT subscription)")
        print(f"    - Status:       {x['status'].upper()} | advisors.json enabled={x['enabled']}")

    h = report["hermes"]
    print("\n[4] Hermes Agent & Nous Research (Device Specialist & Advisory Member)")
    print(f"    - Binary:       {h['binary']} ({flag(h['present'])})")
    if h["nous_lead_model"]:
        print(f"    - Advisory Lead: {h['nous_lead_model']} (general cascade default, $0 cost)")
    if h["nous_error"]:
        print(f"    - Nous Auth:    ERROR ({h['nous_error']})")
    else:
        print(f"    - Nous Auth:    {'OK (token found)' if h['nous_authed'] else 'MISSING (no NOUS_API_KEY / Hermes auth.json entry)'}")
    advisory_status = "ONLINE" if (h["nous_enabled"] and h["nous_authed"]) else "OFFLINE"
    print(f"    - Advisory:     {advisory_status} (advisors.json enabled={h['nous_enabled']}, priority {h['nous_priority'] if h['nous_priority'] is not None else 'n/a'})")
    relay = f"Port {h['relay_port']} LISTENING (Phone bridge connected)" if h["relay_listening"] else f"Port {h['relay_port']} STANDBY (Will accept connection from com.hermesandroid.bridge)"
    print(f"    - Android Relay: {relay}")

    loc = report["local"]
    print("\n[5] Local Subsystems (On-Device Local Memory & Execution)")
    p = loc["pieces_os"]
    print(f"    - PiecesOS:     {'ONLINE' if p['online'] else 'STANDBY'} (port {p['port']})")
    o = loc["ollama"]
    print(f"    - Ollama:       {'ONLINE' if o['online'] else 'STANDBY'} (port {o['port']})")
    t = loc["triad_server"]
    print(f"    - Triad HTTP:   {'LISTENING' if t['online'] else 'NOT RUNNING'} (port {t['port']}, start with 'triad listen')")

    circ = report.get("circuits") or {}
    print("\n[6] Advisor Circuits (skip open advisors instead of waiting out their timeout)")
    if not circ.get("enabled", True):
        print("    - Disabled (TRIAD_CIRCUIT=0)")
    else:
        advisors_circ = circ.get("advisors") or {}
        if not advisors_circ:
            print("    - All closed (no recent failures)")
        else:
            for name, entry in advisors_circ.items():
                if not isinstance(entry, dict):
                    continue
                state = str(entry.get("state") or "closed").upper()
                if state == "OPEN":
                    print(f"    - {name}: OPEN ({entry.get('reason')}, {entry.get('remaining_seconds', 0)}s remaining)")
                else:
                    print(f"    - {name}: closed")
        if circ.get("path"):
            print(f"    - State:        {circ['path']}")

    print("\n================================================================================")
    if report["healthy"]:
        print(f"TRIAD AUDIT SUMMARY: HEALTHY. Usable advisors: {', '.join(report['usable_advisors'])}.")
    else:
        print("TRIAD AUDIT SUMMARY: DEGRADED. No enabled advisor is currently usable.")
    for w in report["warnings"]:
        print(f"  ! {w}")
    print("================================================================================\n")


def cmd_doctor(args):
    """
    Run the diagnostic audit across all platform layers.

    Exit code is 0 when at least one enabled advisor is usable, otherwise 1 - so the
    command is meaningful in scripts (``scripts/verify.ps1`` previously always succeeded).
    ``--quick`` skips the live Claude probe; ``--json`` emits the structured report.
    """
    if getattr(args, "reset_circuits", False):
        reset_circuit(None)
        print("[Triad] Cleared advisor circuit-breaker cooldowns.")
    quick = bool(getattr(args, "quick", False))
    report = collect_doctor_report(probe_advisors=not quick)
    if getattr(args, "json", False):
        print(json.dumps(report, indent=2, default=str))
    else:
        _render_doctor_report(report)
    if not report["healthy"]:
        sys.exit(1)

def _handle_adversarial_session_result(session: Dict[str, Any]) -> None:
    """Enforces consistent adversarial arena exit behavior across review, consult, and debug."""
    quorum_met = bool(session.get("quorum_met", False))
    status = str(session.get("status", "error"))
    verdict = session.get("verdict")
    if not quorum_met:
        print("\n❌ [Adversarial Arena] Quorum failure: insufficient ready advisors for adversarial evaluation.", file=sys.stderr)
        sys.exit(1)
    if status != "ok":
        print(f"\n❌ [Adversarial Arena] Adversarial evaluation failed with status: {status}.", file=sys.stderr)
        sys.exit(1)
    if verdict != "RESILIENT":
        print(f"\n❌ [Adversarial Arena] Red team identified critical vulnerabilities or verdict inconclusive (VERDICT: {verdict or 'UNKNOWN'}).", file=sys.stderr)
        sys.exit(1)
    print("\n✅ [Adversarial Arena] Passed adversarial audit (VERDICT: RESILIENT).")


def cmd_review(args, env: Optional[Dict[str, str]] = None):
    """Review git diff with the Advisory Council."""
    diff_file = getattr(args, "diff_file", "")
    diff_content = ""
    if diff_file:
        if diff_file == "-":
            diff_content = sys.stdin.read()
        elif os.path.exists(diff_file):
            with open(diff_file, "r", encoding="utf-8", errors="replace") as f:
                diff_content = f.read()
    elif getattr(args, "_in_worktree", False) and getattr(args, "_review_base", None):
        ret, out_diff, err_diff = run_subprocess_tree_safe(
            ["git", "diff", "--no-color", "--no-ext-diff", "--no-textconv", args._review_base, "--"],
            cwd=Path.cwd(),
            env=clean_git_env(base_env=env)
        )
        if ret != 0:
            print(f"❌ [Triad Error] Failed to extract diff against review base {args._review_base}: {err_diff.strip()}", file=sys.stderr)
            sys.exit(1)
        diff_content = out_diff.strip()
    else:
        try:
            diff_content = get_git_diff(
                cached=getattr(args, "cached", False),
                head=getattr(args, "head", False),
                env=env
            )
        except Exception as e:
            print(f"[Triad Error] Failed to retrieve git diff: {e}", file=sys.stderr)
            sys.exit(1)

    if not diff_content:
        print("[Triad] No git diff found to review. Stage changes or specify --diff-file.")
        sys.exit(0)

    prompt = getattr(args, "prompt", "")
    if isinstance(prompt, list):
        prompt = " ".join(prompt).strip()
    prompt = prompt or "Review this git diff for edge cases, subtle bugs, type soundness, and architectural regressions."
    engine = getattr(args, "engine", "auto")
    competition = getattr(args, "competition", False) or getattr(args, "adversarial", False)
    if competition:
        adv_pair = ("mock", "mock") if engine == "mock" else ("claude", "codex")
        is_adv = bool(getattr(args, "adversarial", False))
        mode_desc = "Adversarial Red/Blue Arena" if is_adv else "Concurrent Dual Advisors"
        print(f"[Triad Competition Mode] Evaluating diff via {mode_desc} ({adv_pair[0]} vs {adv_pair[1]})...")
        session = query_competition_council(prompt, diff=diff_content, mode="review_diff", advisor_names=adv_pair, adversarial=is_adv)
        synth = session.get("synthesis", "")
        print("\n" + synth)
        if is_adv:
            _handle_adversarial_session_result(session)
        elif session.get("status") == "error":
            print(f"\n❌ [Competition Mode] Review evaluation failed with status: {session.get('status')}", file=sys.stderr)
            sys.exit(1)
        elif session.get("status") == "degraded" or not session.get("quorum_met"):
            print("\n⚠️ [Competition Mode Warning] Review ran in degraded mode (quorum not met; single-advisor fallback)", file=sys.stderr)
        return

    print(f"[Triad] Reviewing {len(diff_content.splitlines())} diff lines via Advisory Council (engine={engine})...\n")
    resp = query_advisory_council(prompt, diff=diff_content, mode="review_diff", engine=engine)
    print(resp)

def cmd_consult(args):
    """Consult the Advisory Council for architectural / system design."""
    prompt = getattr(args, "prompt", "")
    if isinstance(prompt, list):
        prompt = " ".join(prompt).strip()
    if not prompt and not sys.stdin.isatty():
        prompt = sys.stdin.read().strip()

    if not prompt:
        print("Usage: triad consult '<prompt>' [--context '...']")
        sys.exit(1)

    context = getattr(args, "context", "") or ""
    context_file = getattr(args, "context_file", "")
    if context_file and os.path.exists(context_file):
        with open(context_file, "r", encoding="utf-8", errors="replace") as f:
            context = f.read()

    engine = getattr(args, "engine", "auto")
    competition = getattr(args, "competition", False) or getattr(args, "adversarial", False)
    if competition:
        adv_pair = ("mock", "mock") if engine == "mock" else ("claude", "codex")
        is_adv = bool(getattr(args, "adversarial", False))
        mode_desc = "Adversarial Red/Blue Arena" if is_adv else "Concurrent Dual Advisors"
        print(f"[Triad Competition Mode] Consulting {mode_desc} ({adv_pair[0]} vs {adv_pair[1]})...")
        session = query_competition_council(prompt, context=context, mode="architect", advisor_names=adv_pair, adversarial=is_adv)
        print("\n" + session["synthesis"])
        if is_adv:
            _handle_adversarial_session_result(session)
        return

    print(f"[Triad] Consulting Advisory Council (engine={engine})...\n")
    resp = query_advisory_council(prompt, context=context, mode="architect", engine=engine)
    print(resp)

def cmd_debug(args):
    """Debug an error or stack trace with the Advisory Council."""
    raw_error = getattr(args, "error", "")
    if isinstance(raw_error, list):
        raw_error = " ".join(raw_error).strip()
    error = str(raw_error or "").strip()

    if not error:
        raw_prompt = getattr(args, "prompt", "")
        if isinstance(raw_prompt, list):
            raw_prompt = " ".join(raw_prompt).strip()
        error = str(raw_prompt or "").strip()

    if not error and not sys.stdin.isatty():
        error = sys.stdin.read().strip()

    if not error:
        print("Usage: triad debug '<error description or stacktrace>' [--context '...']")
        sys.exit(1)

    context = getattr(args, "context", "") or ""
    context_file = getattr(args, "context_file", "")
    if context_file and os.path.exists(context_file):
        with open(context_file, "r", encoding="utf-8", errors="replace") as f:
            context = f.read()

    engine = getattr(args, "engine", "auto")
    competition = getattr(args, "competition", False) or getattr(args, "adversarial", False)
    if competition:
        adv_pair = ("mock", "mock") if engine == "mock" else ("claude", "codex")
        is_adv = bool(getattr(args, "adversarial", False))
        mode_desc = "Adversarial Red/Blue Arena" if is_adv else "Concurrent Dual Advisors"
        print(f"[Triad Competition Mode] Diagnosing error via {mode_desc} ({adv_pair[0]} vs {adv_pair[1]})...")
        session = query_competition_council(error, context=context, mode="debug", advisor_names=adv_pair, adversarial=is_adv)
        print("\n" + session["synthesis"])
        if is_adv:
            _handle_adversarial_session_result(session)
        return

    print(f"[Triad] Diagnosing with Advisory Council (engine={engine})...\n")
    resp = query_advisory_council(error, context=context, mode="debug", engine=engine)
    print(resp)

def apply_patch_text(patch_text: str, cwd: Optional[Path] = None, env: Optional[Dict[str, str]] = None, allow_3way: bool = False) -> bool:
    """Extracts unified diff from model response, validates with git apply --check, and applies it."""
    import re
    # Extract fenced code blocks or raw diff
    m = re.search(r"```(?:diff|patch)?\s*\n(.*?)```", patch_text, re.DOTALL)
    raw_diff = m.group(1).strip() if m else patch_text.strip()

    # Verify minimum diff headers
    has_diff_headers = (
        ("diff --git " in raw_diff or ("--- " in raw_diff and "+++" in raw_diff))
        and "@@ " in raw_diff
    )
    if not has_diff_headers:
        return False

    target_dir = cwd or Path.cwd()
    exec_env = env if env is not None else clean_git_env()

    # Create safe unique temp patch file
    fd, temp_patch_path = tempfile.mkstemp(suffix=".patch", prefix="triad_heal_")
    try:
        with open(fd, "w", encoding="utf-8") as f:
            f.write(raw_diff + "\n")

        # 1. Check dry-run with whitespace tolerance for Windows
        check_cmd = ["git", "apply", "--check", "--whitespace=fix", "--ignore-whitespace", temp_patch_path]
        check_res = subprocess.run(check_cmd, cwd=str(target_dir), env=exec_env, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if check_res.returncode != 0:
            if not allow_3way:
                return False
            # Fallback retry with 3-way merge (strictly isolated to ephemeral worktrees)
            check_cmd = ["git", "apply", "--check", "--3way", temp_patch_path]
            check_res = subprocess.run(check_cmd, cwd=str(target_dir), env=exec_env, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if check_res.returncode != 0:
                return False
            apply_cmd = ["git", "apply", "--3way", temp_patch_path]
        else:
            apply_cmd = ["git", "apply", "--whitespace=fix", "--ignore-whitespace", temp_patch_path]

        # 2. Apply patch
        apply_res = subprocess.run(apply_cmd, cwd=str(target_dir), env=exec_env, capture_output=True, text=True, encoding="utf-8", errors="replace")
        return apply_res.returncode == 0
    except Exception:
        return False
    finally:
        if os.path.exists(temp_patch_path):
            try:
                os.remove(temp_patch_path)
            except Exception:
                pass

def _modes_match(mode1: Optional[int], mode2: Optional[int], is_git_comparison: bool = False) -> bool:
    """
    Compare file permission modes, normalizing for OS differences and Git executable bit semantics.
    On Unix:
    - If is_git_comparison is False (default): Compares exact 0o777 bits between filesystem states.
    - If is_git_comparison is True: Normalizes git tree modes (0o644 / 0o755) against filesystem modes
      (e.g. 0o664 / 0o775) by checking executable bit parity (0o111).
    On Windows (nt):
    - Windows does not track POSIX group/other or execute bits; stat() only reflects read-only flag.
      Checks read-only bit parity (0o200 / stat.S_IWRITE). If is_git_comparison is True and executable
      bits are present, also rejects executable status mismatch.
    """
    if mode1 is None or mode2 is None:
        return mode1 == mode2
    m1 = mode1 & 0o777
    m2 = mode2 & 0o777
    if m1 == m2:
        return True
    if is_git_comparison:
        if bool(m1 & 0o111) != bool(m2 & 0o111):
            return False
        if os.name == "nt":
            return bool(m1 & 0o200) == bool(m2 & 0o200)
        is_m1_git = (m1 in (0o644, 0o755))
        is_m2_git = (m2 in (0o644, 0o755))
        if is_m1_git or is_m2_git:
            return True
        return False
    if os.name == "nt":
        return bool(m1 & 0o200) == bool(m2 & 0o200)
    return False


@contextlib.contextmanager
def acquire_repo_mutation_lock(repo_root: Union[str, Path]):
    """
    Acquire an exclusive cooperative lock across patch application and rollback phases.
    Prevents concurrent writers from interleaving mutations in the same repository.
    Ensures lockfile always resides in git metadata or system temp, never in the working tree.
    """
    repo_path = Path(repo_root).resolve()
    lock_file = None
    try:
        ret, out, _ = run_subprocess_tree_safe(["git", "rev-parse", "--git-path", "triad_mutation.lock"], cwd=repo_path)
        if ret == 0 and out.strip():
            p = Path(out.strip())
            lock_file = p if p.is_absolute() else (repo_path / p).resolve()
    except Exception:
        pass

    if lock_file is None:
        git_dir = repo_path / ".git"
        if git_dir.is_dir():
            lock_file = git_dir / "triad_mutation.lock"
        elif git_dir.is_file():
            try:
                content = git_dir.read_text(encoding="utf-8", errors="replace").strip()
                if content.startswith("gitdir:"):
                    gitdir = content[len("gitdir:"):].strip()
                    lock_file = (Path(gitdir).resolve()) / "triad_mutation.lock"
            except Exception:
                pass
        if lock_file is None:
            import hashlib
            h = hashlib.sha256(str(repo_path).encode("utf-8")).hexdigest()[:12]
            if not re.fullmatch(r"[0-9a-f]{12}", h):
                raise ValueError("Computed mutation-lock hash was not a well-formed hex digest")
            lock_file = Path(tempfile.gettempdir()) / f"triad_mutation_{h}.lock"

    lock_file.parent.mkdir(parents=True, exist_ok=True)

    # O_NOFOLLOW: this path can fall back to a name derived from a hash of the
    # repo path inside the shared system temp directory, so it must never
    # follow a pre-planted symlink there.
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    try:
        fd = os.open(str(lock_file), flags, 0o600)
    except OSError as e:
        raise RuntimeError(f"Could not open repository mutation lockfile {lock_file}: {e}")

    try:
        if os.name == "nt":
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            try:
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            except (OSError, IOError) as e:
                raise RuntimeError(f"Could not acquire repository mutation lock on {lock_file}: {e}")
        else:
            import fcntl
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (OSError, IOError) as e:
                raise RuntimeError(f"Could not acquire repository mutation lock on {lock_file}: {e}")
        yield lock_file
    finally:
        try:
            if os.name == "nt":
                import msvcrt
                try:
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                except Exception:
                    pass
            else:
                import fcntl
                try:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                except Exception:
                    pass
        finally:
            try:
                os.close(fd)
            except Exception:
                pass


def _is_symlink_or_reparse(p: Union[str, Path]) -> bool:
    """Check if path is a symlink or a Windows reparse point / junction."""
    try:
        st = os.lstat(p)
        if stat.S_ISLNK(st.st_mode):
            return True
        if hasattr(st, "st_file_attributes"):
            reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
            if bool(st.st_file_attributes & reparse_flag):
                return True
    except (FileNotFoundError, OSError):
        pass
    return False


def _validate_and_resolve_contained_path(target_dir: Path, rel_p: str) -> Optional[Path]:
    """
    Validates that rel_p is strictly contained within target_dir without resolving
    symlinks at the leaf path. Rejects traversal through symlink or Windows reparse/junction
    parent components outright.
    Enforces component-aware relative_to(target_dir) containment rather than string prefix.
    Returns lexical Path(target_dir / norm_rel) or None if traversal/escape detected.
    """
    norm_rel = os.path.normpath(rel_p)
    if os.path.isabs(norm_rel) or norm_rel.startswith("..") or norm_rel == ".":
        return None

    target_dir_real = target_dir.resolve()
    file_p = target_dir / norm_rel
    try:
        file_p.relative_to(target_dir)
    except ValueError:
        return None

    # Reject symlink and Windows reparse/junction parent components outright
    curr = target_dir
    parent_parts = Path(norm_rel).parent.parts
    for part in parent_parts:
        curr = curr / part
        if _is_symlink_or_reparse(curr):
            return None

    # Ensure parent directory (if it exists) is strictly contained in target_dir_real
    parent_dir = target_dir / Path(norm_rel).parent
    try:
        if parent_dir.exists():
            parent_dir.resolve().relative_to(target_dir_real)
    except (ValueError, OSError):
        return None

    return file_p


def parse_diff_tree_records(raw_bytes: bytes) -> List[Dict[str, Any]]:
    """
    Parse git diff-tree -r -z output into structured change records.
    Uses os.fsdecode for lossless round-trip path decoding.
    Rejects malformed or truncated records (fail-closed).
    """
    records = []
    tokens = raw_bytes.split(b"\x00")
    if tokens and tokens[-1] == b"":
        tokens.pop()
    i = 0
    while i < len(tokens):
        meta_bytes = tokens[i].strip()
        if not meta_bytes:
            i += 1
            continue
        if not meta_bytes.startswith(b":"):
            raise ValueError(f"Malformed diff-tree record: {meta_bytes!r}")
        parts = meta_bytes[1:].split()
        if len(parts) < 5:
            raise ValueError(f"Incomplete diff-tree metadata: {meta_bytes!r}")
        src_mode = parts[0].decode("ascii", errors="strict")
        dst_mode = parts[1].decode("ascii", errors="strict")
        src_sha = parts[2].decode("ascii", errors="strict")
        dst_sha = parts[3].decode("ascii", errors="strict")
        status = parts[4].decode("ascii", errors="strict")
        i += 1
        if i >= len(tokens):
            raise ValueError("Truncated diff-tree stream: missing path")
        path1 = os.fsdecode(tokens[i])
        i += 1
        path2 = None
        if status.startswith("R") or status.startswith("C"):
            if i >= len(tokens):
                raise ValueError("Truncated diff-tree stream: missing rename/copy destination path")
            path2 = os.fsdecode(tokens[i])
            i += 1
        records.append({
            "src_mode": src_mode,
            "dst_mode": dst_mode,
            "src_sha": src_sha,
            "dst_sha": dst_sha,
            "status": status,
            "src_path": path1,
            "dst_path": path2 or path1,
            "is_rename_or_copy": bool(path2)
        })
    return records


def get_tree_entries(tree_oid: str, repo_dir: Path, env: Optional[Dict[str, str]] = None) -> Dict[str, Tuple[str, str, str]]:
    """
    Returns a dict mapping rel_path -> (mode, type, sha) for all entries in tree_oid.
    Uses git ls-tree -r -z.
    Raises RuntimeError on command failure or malformed records so enumeration failures cannot masquerade as empty trees.
    """
    ret, out, err = run_subprocess_tree_safe_bytes(["git", "ls-tree", "-r", "-z", tree_oid], cwd=repo_dir, env=env)
    if ret != 0:
        err_msg = err.decode("utf-8", errors="replace") if isinstance(err, bytes) else str(err)
        raise RuntimeError(f"git ls-tree failed for tree {tree_oid}: {err_msg.strip()}")
    res = {}
    tokens = out.split(b"\x00")
    for tok in tokens:
        if not tok:
            continue
        parts = tok.split(b"\t", 1)
        if len(parts) != 2:
            raise RuntimeError(f"Malformed git ls-tree record in tree {tree_oid}: {repr(tok)}")
        meta, path_bytes = parts
        rel_p = os.fsdecode(path_bytes)
        meta_parts = meta.split()
        if len(meta_parts) < 3:
            raise RuntimeError(f"Malformed git ls-tree metadata in tree {tree_oid}: {repr(meta)}")
        mode = meta_parts[0].decode("ascii", errors="replace")
        obj_type = meta_parts[1].decode("ascii", errors="replace")
        sha = meta_parts[2].decode("ascii", errors="replace")
        res[rel_p] = (mode, obj_type, sha)
    return res


def _content_matches(cur: Optional[bytes], expected: Optional[bytes]) -> bool:
    """Compare byte contents with CRLF/LF normalization to account for Git smudge/clean filters."""
    if cur == expected:
        return True
    if cur is None or expected is None:
        return False
    return cur.replace(b"\r\n", b"\n") == expected.replace(b"\r\n", b"\n")


def _restore_entry(p: Path, info: Dict[str, Any], target_dir: Path) -> bool:
    """
    Restore a single path to its original baseline state, returning True on success.
    Strict non-destructive best-effort rollback: opens regular files with O_NOFOLLOW | O_RDWR (or O_CREAT | O_EXCL),
    re-verifies exact bytes and permissions directly from the open descriptor before any mutation to eliminate
    TOCTOU windows, refuses destructive deletion of directories, and aborts if concurrent edits or ownership
    mismatches are detected. Rollback is strictly cooperative single-writer; on any conflict, user workspace
    state is preserved intact and the unmerged recovery patch (get_recovery_patch_path) serves as the safety net.
    """
    try:
        try:
            rel_p = str(p.relative_to(target_dir))
        except ValueError:
            return False
        if _validate_and_resolve_contained_path(target_dir, rel_p) is None:
            return False

        if info["is_symlink"]:
            try:
                st = os.lstat(p)
                is_link = stat.S_ISLNK(st.st_mode)
                is_real_dir = stat.S_ISDIR(st.st_mode)
            except (FileNotFoundError, OSError):
                st = None
                is_link = False
                is_real_dir = False

            if is_real_dir:
                print(f"⚠️ [Triad Conflict] Path {p} is a real directory; refusing destructive removal during symlink rollback.", file=sys.stderr)
                return False

            if is_link:
                expected_link = info.get("expected_target_link")
                if expected_link is not None:
                    try:
                        cur_link = os.readlink(p)
                        if cur_link != expected_link:
                            print(f"⚠️ [Triad Conflict] Symlink target on {p} modified concurrently during rollback. Preserving symlink.", file=sys.stderr)
                            return False
                    except OSError:
                        return False
                else:
                    print(f"⚠️ [Triad Conflict] Symlink on {p} was not expected by mutation during rollback. Refusing destructive removal.", file=sys.stderr)
                    return False
                p.unlink()
            elif p.exists():
                expected_bytes = info.get("expected_target_bytes")
                if expected_bytes is not None:
                    try:
                        if p.read_bytes() != expected_bytes:
                            print(f"⚠️ [Triad Conflict] File content on {p} modified concurrently during rollback. Preserving user path.", file=sys.stderr)
                            return False
                    except OSError:
                        return False
                    p.unlink()
                else:
                    print(f"⚠️ [Triad Conflict] Path {p} was replaced with a non-symlink concurrently during rollback. Preserving user path.", file=sys.stderr)
                    return False
            os.symlink(info["link_target"], p)
            return True
        elif info["is_regular"]:
            p.parent.mkdir(parents=True, exist_ok=True)
            try:
                st = os.lstat(p)
                is_real_dir = stat.S_ISDIR(st.st_mode)
            except (FileNotFoundError, OSError):
                is_real_dir = False
            if is_real_dir:
                print(f"⚠️ [Triad Conflict] Path {p} is a real directory; refusing destructive removal during regular file rollback.", file=sys.stderr)
                return False

            # If operation had deleted this file (expected_target_exists is False),
            # any existing path or symlink means it was recreated concurrently. We must refuse to overwrite it!
            if info.get("expected_target_exists") is False:
                if p.is_symlink() or p.exists():
                    print(f"⚠️ [Triad Conflict] Path {p} was recreated concurrently during rollback. Preserving user path.", file=sys.stderr)
                    return False

            target_mode = info.get("mode")
            if p.is_symlink():
                expected_target_is_link = info.get("expected_target_is_link")
                expected_target_link = info.get("expected_target_link")
                if not expected_target_is_link or expected_target_link is None:
                    print(f"⚠️ [Triad Conflict] Path {p} has unexpected symlink during regular file rollback. Preserving user path.", file=sys.stderr)
                    return False
                try:
                    cur_link = os.readlink(p)
                    if cur_link != expected_target_link:
                        print(f"⚠️ [Triad Conflict] Symlink target on {p} modified concurrently during regular file rollback. Preserving symlink.", file=sys.stderr)
                        return False
                except OSError:
                    return False
                p.unlink()
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
                file_mode = target_mode or 0o666
                try:
                    fd = os.open(str(p), flags, file_mode)
                except OSError:
                    return False
                try:
                    data = info["bytes"]
                    total_written = 0
                    while total_written < len(data):
                        n = os.write(fd, data[total_written:])
                        if n <= 0:
                            raise OSError("os.write made zero progress during restoration")
                        total_written += n
                    if target_mode is not None and os.name != "nt":
                        if hasattr(os, "fchmod"):
                            os.fchmod(fd, target_mode)
                        else:
                            os.chmod(str(p), target_mode)
                        if (os.fstat(fd).st_mode & 0o777) != (target_mode & 0o777):
                            return False
                finally:
                    os.close(fd)
            elif p.exists():
                flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
                try:
                    fd = os.open(str(p), flags)
                except OSError:
                    return False
                try:
                    if os.name == "nt":
                        import msvcrt
                        try:
                            os.lseek(fd, 0, os.SEEK_SET)
                            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                        except (OSError, IOError) as e:
                            print(f"⚠️ [Triad Conflict] Could not acquire lock on {p} during rollback: {e}. Preserving user path.", file=sys.stderr)
                            return False
                    else:
                        import fcntl
                        try:
                            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        except (OSError, IOError) as e:
                            print(f"⚠️ [Triad Conflict] Could not acquire lock on {p} during rollback: {e}. Preserving user path.", file=sys.stderr)
                            return False

                    fd_st = os.fstat(fd)
                    if not stat.S_ISREG(fd_st.st_mode):
                        return False

                    # Read all descriptor bytes directly from open fd
                    cur_fd_bytes = b""
                    while True:
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break
                        cur_fd_bytes += chunk

                    needs_mode_restore = False
                    if target_mode is not None and os.name != "nt":
                        if (fd_st.st_mode & 0o777) != (target_mode & 0o777):
                            needs_mode_restore = True

                    # Exact byte equality check: if already matches baseline bytes:
                    if cur_fd_bytes == info["bytes"]:
                        if needs_mode_restore:
                            try:
                                if hasattr(os, "fchmod"):
                                    os.fchmod(fd, target_mode)
                                else:
                                    os.chmod(str(p), target_mode)
                                cur_mode = os.fstat(fd).st_mode & 0o777
                                if cur_mode != (target_mode & 0o777):
                                    return False
                            except Exception as e:
                                print(f"⚠️ [Triad Rollback Error] Failed restoring mode on {p}: {e}", file=sys.stderr)
                                return False
                        return True

                    # Verify descriptor content matches expected target bytes (exact byte equality)
                    expected_target = info.get("expected_target_bytes")
                    if expected_target is not None and cur_fd_bytes != expected_target:
                        # Descriptor content mutated concurrently!
                        return False

                    # Re-verify stat and re-read descriptor bytes immediately before truncate to guard against TOCTOU
                    pre_st = os.fstat(fd)
                    if pre_st.st_size != len(cur_fd_bytes):
                        return False

                    os.lseek(fd, 0, os.SEEK_SET)
                    pre_bytes = b""
                    while True:
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break
                        pre_bytes += chunk
                    if pre_bytes != cur_fd_bytes:
                        return False

                    os.ftruncate(fd, 0)
                    os.lseek(fd, 0, os.SEEK_SET)
                    data = info["bytes"]
                    total_written = 0
                    while total_written < len(data):
                        n = os.write(fd, data[total_written:])
                        if n <= 0:
                            raise OSError("os.write made zero progress during restoration")
                        total_written += n

                    if target_mode is not None and os.name != "nt":
                        try:
                            if hasattr(os, "fchmod"):
                                os.fchmod(fd, target_mode)
                            else:
                                os.chmod(str(p), target_mode)
                            cur_mode = os.fstat(fd).st_mode & 0o777
                            if cur_mode != (target_mode & 0o777):
                                return False
                        except Exception as e:
                            print(f"⚠️ [Triad Rollback Error] Failed restoring mode on {p}: {e}", file=sys.stderr)
                            return False
                finally:
                    if os.name == "nt":
                        import msvcrt
                        try:
                            os.lseek(fd, 0, os.SEEK_SET)
                            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                        except Exception:
                            pass
                    else:
                        import fcntl
                        try:
                            fcntl.flock(fd, fcntl.LOCK_UN)
                        except Exception:
                            pass
                    os.close(fd)
            else:
                # Newly created paths during restoration use O_CREAT | O_EXCL
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
                file_mode = target_mode or 0o666
                try:
                    fd = os.open(str(p), flags, file_mode)
                except OSError:
                    return False
                try:
                    data = info["bytes"]
                    total_written = 0
                    while total_written < len(data):
                        n = os.write(fd, data[total_written:])
                        if n <= 0:
                            raise OSError("os.write made zero progress during restoration")
                        total_written += n
                    if target_mode is not None and os.name != "nt":
                        if hasattr(os, "fchmod"):
                            os.fchmod(fd, target_mode)
                        else:
                            os.chmod(str(p), target_mode)
                        if (os.fstat(fd).st_mode & 0o777) != (target_mode & 0o777):
                            return False
                finally:
                    os.close(fd)

            # Verify restored regular file bytes with exact byte equality
            if p.read_bytes() != info["bytes"]:
                return False

            if target_mode is not None and os.name != "nt":
                if (os.lstat(p).st_mode & 0o777) != (target_mode & 0o777):
                    return False
            return True
        elif not info["existed"]:
            if p.is_dir():
                print(f"⚠️ [Triad Conflict] Path {p} is a directory; refusing destructive removal during rollback.", file=sys.stderr)
                return False
            if p.is_symlink():
                try:
                    cur_link = os.readlink(p)
                    if info.get("expected_target_link") is not None and cur_link != info.get("expected_target_link"):
                        print(f"⚠️ [Triad Conflict] Symlink target on {p} modified concurrently during rollback. Preserving symlink.", file=sys.stderr)
                        return False
                except OSError:
                    return False
                p.unlink()
                return True
            if p.is_file():
                flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
                try:
                    fd = os.open(str(p), flags)
                except OSError:
                    return False
                try:
                    if os.name == "nt":
                        import msvcrt
                        try:
                            os.lseek(fd, 0, os.SEEK_SET)
                            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                        except (OSError, IOError) as e:
                            print(f"⚠️ [Triad Conflict] Could not acquire lock on {p} during rollback: {e}. Preserving file.", file=sys.stderr)
                            return False
                    else:
                        import fcntl
                        try:
                            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        except (OSError, IOError) as e:
                            print(f"⚠️ [Triad Conflict] Could not acquire lock on {p} during rollback: {e}. Preserving file.", file=sys.stderr)
                            return False
                    cur_bytes = b""
                    while True:
                        chunk = os.read(fd, 65536)
                        if not chunk:
                            break
                        cur_bytes += chunk
                    if info.get("expected_target_bytes") is not None and cur_bytes != info.get("expected_target_bytes"):
                        print(f"⚠️ [Triad Conflict] Concurrent write detected on newly created file {p} before unlink. Preserving file.", file=sys.stderr)
                        return False
                finally:
                    if os.name == "nt":
                        import msvcrt
                        try:
                            os.lseek(fd, 0, os.SEEK_SET)
                            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                        except Exception:
                            pass
                    else:
                        import fcntl
                        try:
                            fcntl.flock(fd, fcntl.LOCK_UN)
                        except Exception:
                            pass
                    os.close(fd)
                p.unlink()
                return True
            return True
        return True
    except Exception as e:
        print(f"⚠️ [Triad Rollback Error] Failed restoring {p}: {e}", file=sys.stderr)
        return False


def _rollback(entries: Dict[Path, Dict[str, Any]], target_dir: Path) -> bool:
    """
    Safely roll back applied changes using descriptor-based no-follow writes and pre-mutation re-verification.
    Operating Contract:
    - Assumes a cooperative single-writer model within the repository workspace (coordinated via
      acquire_repo_mutation_lock and file-level advisory locks).
    - Uncoordinated external writers (such as background tools or editors that bypass locks) cannot be
      atomically excluded across multi-step OS primitives (e.g. readlink-unlink or fstat-ftruncate).
    - Under this contract, rollback is strictly non-destructive and fail-safe: any detected state
      divergence, unexpected inode, or concurrent mutation immediately aborts rollback mutations
      to avoid clobbering user files, preserving the complete unmerged recovery patch artifact on disk.
    - Re-validates parent containment against symlink/reparse point redirection.
    - Returns True if all paths were cleanly rolled back or confirmed untouched, False on conflicts.
    """
    # Phase 1: Concurrency and ownership validation.
    # If ANY path has concurrent modification, uncertain ownership, or parent containment violation,
    # abort all automatic rollback mutations.
    for p, info in entries.items():
        try:
            try:
                rel_p = str(p.relative_to(target_dir))
            except ValueError:
                print(f"⚠️ [Triad Rollback Error] Path {p} escapes target directory {target_dir}", file=sys.stderr)
                return False

            if _validate_and_resolve_contained_path(target_dir, rel_p) is None:
                print(f"⚠️ [Triad Rollback Error] Path {p} parent directory symlink/reparse traversal detected", file=sys.stderr)
                return False

            try:
                cur_st = os.lstat(p)
                cur_exists = True
                cur_is_link = stat.S_ISLNK(cur_st.st_mode)
                cur_is_dir = stat.S_ISDIR(cur_st.st_mode)
                cur_link = os.readlink(p) if cur_is_link else None
                cur_bytes = p.read_bytes() if stat.S_ISREG(cur_st.st_mode) else None
            except (FileNotFoundError, OSError):
                cur_exists = False
                cur_st = None
                cur_is_link = False
                cur_is_dir = False
                cur_link = None
                cur_bytes = None

            if cur_exists and cur_is_dir and not info.get("is_dir", False):
                print(f"⚠️ [Triad Conflict] Path {p} is a directory; refusing automatic rollback to prevent destructive removal.", file=sys.stderr)
                return False

            target_mode = info.get("target_mode")
            if target_mode is None and "record" in info and isinstance(info.get("record"), dict) and "dst_mode" in info["record"]:
                try:
                    target_mode = int(info["record"]["dst_mode"], 8)
                except Exception:
                    pass
            if target_mode is None and info.get("mode") is not None:
                target_mode = info.get("mode")

            # Path did not exist before this operation
            if not info["existed"]:
                if not cur_exists:
                    continue
                if info.get("expected_target_is_link"):
                    matches_written = cur_is_link and (cur_link == info.get("expected_target_link"))
                else:
                    matches_written = not cur_is_link and (cur_bytes == info.get("expected_target_bytes")) and (target_mode is None or _modes_match(cur_st.st_mode, target_mode, is_git_comparison=True))
                if not matches_written:
                    print(f"⚠️ [Triad Conflict] Concurrent modification detected on newly created path: {p}", file=sys.stderr)
                    return False
                continue

            # Path existed before this operation
            # Subcase: operation was deleting it
            if not info.get("expected_target_exists", True):
                if not cur_exists:
                    continue
                matches_baseline = False
                if info["is_symlink"]:
                    matches_baseline = cur_is_link and (cur_link == info["link_target"])
                elif info["is_regular"]:
                    matches_baseline = not cur_is_link and (cur_bytes == info["bytes"]) and (info.get("mode") is None or _modes_match(cur_st.st_mode, info["mode"], is_git_comparison=False))
                if not matches_baseline:
                    print(f"⚠️ [Triad Conflict] Concurrent modification detected on deletion candidate: {p}", file=sys.stderr)
                    return False
                continue

            # Subcase: operation was modifying it
            if not cur_exists:
                print(f"⚠️ [Triad Conflict] Path unexpectedly deleted concurrently: {p}", file=sys.stderr)
                return False

            matches_baseline = False
            if info["is_symlink"]:
                matches_baseline = cur_is_link and (cur_link == info["link_target"])
            elif info["is_regular"]:
                matches_baseline = not cur_is_link and (cur_bytes == info["bytes"]) and (info.get("mode") is None or _modes_match(cur_st.st_mode, info["mode"], is_git_comparison=False))

            if matches_baseline:
                continue

            matches_written = False
            if info.get("expected_target_is_link"):
                matches_written = cur_is_link and (cur_link == info.get("expected_target_link"))
            else:
                matches_written = not cur_is_link and (cur_bytes == info.get("expected_target_bytes")) and (target_mode is None or _modes_match(cur_st.st_mode, target_mode, is_git_comparison=True))

            if not matches_written:
                print(f"⚠️ [Triad Conflict] Concurrent user edits detected on {p}. Automatic rollback aborted to preserve concurrent edits.", file=sys.stderr)
                return False

        except Exception as e:
            print(f"⚠️ [Triad Conflict] Error checking concurrent state for {p}: {e}", file=sys.stderr)
            return False

    # Phase 2: Immediate pre-mutation re-verification per path before modifying or unlinking.
    # Never restore or unlink a path unless its current state STILL matches the expected written state.
    all_clean = True
    for p, info in entries.items():
        try:
            try:
                rel_p = str(p.relative_to(target_dir))
            except ValueError:
                all_clean = False
                continue

            if _validate_and_resolve_contained_path(target_dir, rel_p) is None:
                all_clean = False
                continue

            target_mode = info.get("target_mode")
            if target_mode is None and "record" in info and isinstance(info.get("record"), dict) and "dst_mode" in info["record"]:
                try:
                    target_mode = int(info["record"]["dst_mode"], 8)
                except Exception:
                    pass
            if target_mode is None and info.get("mode") is not None:
                target_mode = info.get("mode")

            # Subcase A: Path did not exist before this operation (we created it)
            if not info["existed"]:
                if p.is_symlink() or p.exists():
                    try:
                        cur_st = os.lstat(p)
                        cur_is_link = stat.S_ISLNK(cur_st.st_mode)
                        cur_link = os.readlink(p) if cur_is_link else None
                    except (FileNotFoundError, OSError):
                        continue

                    if cur_is_link:
                        expected_link = info.get("expected_target_link")
                        if not info.get("expected_target_is_link") or expected_link is None or cur_link != expected_link:
                            print(f"⚠️ [Triad Conflict] Concurrent modification detected on newly created symlink during rollback: {p}. Preserving path.", file=sys.stderr)
                            all_clean = False
                            continue
                        try:
                            post_st = os.lstat(p)
                            if not stat.S_ISLNK(post_st.st_mode) or os.readlink(p) != expected_link:
                                print(f"⚠️ [Triad Conflict] Symlink target on {p} modified concurrently immediately prior to unlink. Preserving path.", file=sys.stderr)
                                all_clean = False
                                continue
                        except Exception:
                            all_clean = False
                            continue
                        p.unlink()
                    elif stat.S_ISREG(cur_st.st_mode):
                        expected_bytes = info.get("expected_target_bytes")
                        if expected_bytes is None:
                            print(f"⚠️ [Triad Conflict] Path {p} was not expected to be a regular file during rollback. Preserving path.", file=sys.stderr)
                            all_clean = False
                            continue
                        flags = os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
                        try:
                            fd = os.open(str(p), flags)
                        except OSError:
                            all_clean = False
                            continue
                        try:
                            if os.name == "nt":
                                import msvcrt
                                try:
                                    os.lseek(fd, 0, os.SEEK_SET)
                                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                                except (OSError, IOError):
                                    all_clean = False
                                    continue
                            else:
                                import fcntl
                                try:
                                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                                except (OSError, IOError):
                                    all_clean = False
                                    continue
                            fd_st = os.fstat(fd)
                            if not stat.S_ISREG(fd_st.st_mode) or fd_st.st_size != len(expected_bytes):
                                all_clean = False
                                continue
                            os.lseek(fd, 0, os.SEEK_SET)
                            cur_fd_bytes = b""
                            while True:
                                chunk = os.read(fd, 65536)
                                if not chunk:
                                    break
                                cur_fd_bytes += chunk
                            if cur_fd_bytes != expected_bytes or (target_mode is not None and not _modes_match(fd_st.st_mode, target_mode, is_git_comparison=True)):
                                print(f"⚠️ [Triad Conflict] Concurrent modification detected on newly created file during rollback: {p}. Preserving path.", file=sys.stderr)
                                all_clean = False
                                continue
                        finally:
                            if os.name == "nt":
                                import msvcrt
                                try:
                                    os.lseek(fd, 0, os.SEEK_SET)
                                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                                except Exception:
                                    pass
                            else:
                                import fcntl
                                try:
                                    fcntl.flock(fd, fcntl.LOCK_UN)
                                except Exception:
                                    pass
                            os.close(fd)
                        try:
                            post_close_st = os.lstat(p)
                            if not stat.S_ISREG(post_close_st.st_mode) or post_close_st.st_size != len(expected_bytes):
                                print(f"⚠️ [Triad Conflict] File {p} modified concurrently immediately prior to unlink. Preserving file.", file=sys.stderr)
                                all_clean = False
                                continue
                            if hasattr(fd_st, "st_ino") and hasattr(post_close_st, "st_ino") and fd_st.st_ino and post_close_st.st_ino:
                                if post_close_st.st_ino != fd_st.st_ino or getattr(post_close_st, "st_dev", 0) != getattr(fd_st, "st_dev", 0):
                                    print(f"⚠️ [Triad Conflict] File {p} replaced by new inode prior to unlink. Preserving file.", file=sys.stderr)
                                    all_clean = False
                                    continue
                            # Best-effort guard (not atomic): a recreated file normally gets a fresh
                            # ctime, which catches an unlink+recreate with identical content on
                            # filesystems that reuse the freed inode number (tmpfs/overlayfs). Two
                            # limits: a recreate inside one coarse clock tick can go undetected, and
                            # on Windows st_ctime is creation time (NTFS tunneling can restore it),
                            # where the inode/file-ID check above is the effective protection.
                            fd_ctime = getattr(fd_st, "st_ctime_ns", None)
                            post_ctime = getattr(post_close_st, "st_ctime_ns", None)
                            if fd_ctime is not None and post_ctime is not None and post_ctime != fd_ctime:
                                print(f"⚠️ [Triad Conflict] File {p} recreated prior to unlink (ctime changed). Preserving file.", file=sys.stderr)
                                all_clean = False
                                continue
                            post_close_bytes = p.read_bytes()
                            if post_close_bytes != expected_bytes:
                                print(f"⚠️ [Triad Conflict] File {p} content mutated immediately prior to unlink. Preserving file.", file=sys.stderr)
                                all_clean = False
                                continue
                        except Exception:
                            all_clean = False
                            continue
                        p.unlink()
                    else:
                        print(f"⚠️ [Triad Conflict] Path {p} is a directory or special file; refusing destructive removal during rollback. Preserving path.", file=sys.stderr)
                        all_clean = False
                        continue
                continue

            # Subcase B: Path was being deleted by this operation
            if not info.get("expected_target_exists", True):
                if not (p.is_symlink() or p.exists()):
                    if not _restore_entry(p, info, target_dir):
                        all_clean = False
                else:
                    try:
                        cur_st = os.lstat(p)
                        cur_is_link = stat.S_ISLNK(cur_st.st_mode)
                        cur_link = os.readlink(p) if cur_is_link else None
                        cur_bytes = p.read_bytes() if stat.S_ISREG(cur_st.st_mode) else None
                    except (FileNotFoundError, OSError):
                        cur_is_link = False
                        cur_link = None
                        cur_bytes = None

                    matches_baseline = False
                    if info["is_symlink"]:
                        matches_baseline = cur_is_link and (cur_link == info["link_target"])
                    elif info["is_regular"]:
                        matches_baseline = not cur_is_link and (cur_bytes == info["bytes"]) and (info.get("mode") is None or _modes_match(cur_st.st_mode, info["mode"], is_git_comparison=False))
                    if not matches_baseline:
                        print(f"⚠️ [Triad Conflict] Concurrent modification detected on deletion candidate during rollback: {p}. Preserving path.", file=sys.stderr)
                        all_clean = False
                        continue
                continue

            # Subcase C: Path was being modified by this operation
            if not (p.is_symlink() or p.exists()):
                print(f"⚠️ [Triad Conflict] Path unexpectedly deleted concurrently during rollback: {p}.", file=sys.stderr)
                all_clean = False
                continue

            try:
                cur_st = os.lstat(p)
                cur_is_link = stat.S_ISLNK(cur_st.st_mode)
                cur_link = os.readlink(p) if cur_is_link else None
                cur_bytes = p.read_bytes() if stat.S_ISREG(cur_st.st_mode) else None
            except (FileNotFoundError, OSError):
                all_clean = False
                continue

            matches_baseline = False
            if info["is_symlink"]:
                matches_baseline = cur_is_link and (cur_link == info["link_target"])
            elif info["is_regular"]:
                matches_baseline = not cur_is_link and (cur_bytes == info["bytes"]) and (info.get("mode") is None or _modes_match(cur_st.st_mode, info["mode"], is_git_comparison=False))

            if matches_baseline:
                continue

            # Re-verify path matches expected written state right before restoring baseline
            matches_written = False
            if info.get("expected_target_is_link"):
                matches_written = cur_is_link and (cur_link == info.get("expected_target_link"))
            else:
                matches_written = not cur_is_link and (cur_bytes == info.get("expected_target_bytes")) and (target_mode is None or _modes_match(cur_st.st_mode, target_mode, is_git_comparison=True))

            if not matches_written:
                print(f"⚠️ [Triad Conflict] Concurrent user edits detected on {p} during rollback. Automatic rollback aborted for this path to preserve edits.", file=sys.stderr)
                all_clean = False
                continue

            if not _restore_entry(p, info, target_dir):
                all_clean = False

        except Exception as e:
            print(f"⚠️ [Triad Rollback Error] Failed restoring {p}: {e}", file=sys.stderr)
            all_clean = False

    return all_clean


def apply_verified_patch_to_workspace(
    patch_data: Union[str, bytes],
    cwd: Optional[Path] = None,
    env: Optional[Dict[str, str]] = None,
    expected_baseline_tree: Optional[str] = None,
    expected_target_tree: Optional[str] = None
) -> bool:
    """
    Applies a verified self-healing patch to the main working tree using a two-stage
    pre-verification (git apply --check) followed by application.
    Strict byte-preserving mode (--whitespace=nowarn, no --whitespace=fix, no --ignore-whitespace, no --3way).
    When expected_baseline_tree is provided:
    1. Verifies working tree parity immediately before applying (fail-closed concurrency check).
       Uses head_tree=expected_baseline_tree so tracked ignored files are properly preserved.
    2. Computes the exact expected post-application tree by applying the patch to an isolated
       temporary index seeded with expected_baseline_tree (and validates against expected_target_tree if provided).
    3. Enumerates all changes using git diff-tree -r -z -M to capture both rename endpoints and
       preserves filesystem type, link target, and mode via os.lstat(). Aborts before mutation if backup fails.
    4. Safe application protocol: operates under a cooperative single-writer model.
       Because uncoordinated external writers (such as IDE auto-savers) cannot be atomically
       excluded across multi-step Git OS invocations without kernel-level mandatory locking,
       application is strictly non-destructive fail-safe: when git apply fails, unexpected exceptions occur,
       or concurrent modification is detected, the verified recovery patch artifact is preserved on disk
       for manual inspection/application, leaving the workspace intact.
    5. Verifies post-application working tree exactly matches expected_target_tree.
    """
    target_dir = (cwd or Path.cwd()).resolve()
    exec_env = env if env is not None else clean_git_env()

    try:
        lock_ctx = acquire_repo_mutation_lock(target_dir)
        lock_ctx.__enter__()
    except Exception:
        return False

    fd, temp_patch_path = tempfile.mkstemp(suffix=".patch", prefix="triad_verified_")
    backup_entries: Dict[Path, Dict[str, Any]] = {}
    application_started = False

    try:
        raw_bytes = patch_data.encode("utf-8") if isinstance(patch_data, str) else patch_data
        with os.fdopen(fd, "wb") as f:
            f.write(raw_bytes)
            if not raw_bytes.endswith(b"\n"):
                f.write(b"\n")

        baseline_tree = expected_baseline_tree
        if baseline_tree:
            current_wt = snapshot_worktree_tree(target_dir, head_tree=baseline_tree, env=exec_env)
            if current_wt != baseline_tree:
                return False
        else:
            baseline_tree = snapshot_worktree_tree(target_dir, env=exec_env)
            if not baseline_tree:
                return False

        # Compute exact expected target tree using temporary index seeded from baseline_tree
        computed_target_tree = None
        temp_target_index = Path(tempfile.gettempdir()) / f"triad-target-{uuid.uuid4().hex[:8]}"
        temp_target_env = clean_git_env({"GIT_INDEX_FILE": str(temp_target_index)}, base_env=exec_env)
        try:
            r1, _, _ = run_subprocess_tree_safe(["git", "read-tree", baseline_tree], cwd=target_dir, env=temp_target_env)
            if r1 != 0:
                return False
            r2, _, _ = run_subprocess_tree_safe(["git", "apply", "--cached", "--whitespace=nowarn", temp_patch_path], cwd=target_dir, env=temp_target_env)
            if r2 != 0:
                return False
            r3, out_tree, _ = run_subprocess_tree_safe(["git", "write-tree"], cwd=target_dir, env=temp_target_env)
            if r3 != 0 or not out_tree.strip():
                return False
            computed_target_tree = out_tree.strip()
        finally:
            if temp_target_index.exists():
                try:
                    temp_target_index.unlink()
                except Exception:
                    pass

        if computed_target_tree == baseline_tree:
            return False

        if expected_target_tree and computed_target_tree != expected_target_tree:
            return False

        target_tree_to_verify = expected_target_tree or computed_target_tree

        # 1. Enumerate all changes using git diff-tree -r -z -M
        r_diff, diff_out, _ = run_subprocess_tree_safe_bytes(
            ["git", "diff-tree", "-r", "-z", "-M", baseline_tree, target_tree_to_verify],
            cwd=target_dir,
            env=exec_env
        )
        if r_diff != 0 or not diff_out:
            # Abort before mutation if backup discovery fails!
            return False

        records = parse_diff_tree_records(diff_out)
        if not records:
            return False

        # Collect union of all affected paths from diff-tree records
        affected_rel_paths = set()
        for rec in records:
            affected_rel_paths.add(rec["src_path"])
            affected_rel_paths.add(rec["dst_path"])

        # Directly obtain each path's baseline and final target state from the two trees
        try:
            baseline_tree_entries = get_tree_entries(baseline_tree, target_dir, exec_env)
            target_tree_entries = get_tree_entries(target_tree_to_verify, target_dir, exec_env)
        except RuntimeError as e:
            print(f"⚠️ [Triad Worktree Error] Tree entry enumeration failed: {e}", file=sys.stderr)
            return False

        # Explicitly detect unsupported file-to-directory or directory-to-file transitions
        # Build ancestor directory sets to perform O(N * depth) set-intersection checks instead of O(N^2) prefix scans
        baseline_paths = set(baseline_tree_entries.keys())
        target_paths = set(target_tree_entries.keys())

        def _get_ancestor_dirs(path_set: Set[str]) -> Set[str]:
            ancestors = set()
            for p in path_set:
                parts = p.split("/")
                for i in range(1, len(parts)):
                    ancestors.add("/".join(parts[:i]))
            return ancestors

        target_dir_ancestors = _get_ancestor_dirs(target_paths)
        file_to_dir_collisions = baseline_paths.intersection(target_dir_ancestors)
        if file_to_dir_collisions:
            first_col = sorted(file_to_dir_collisions)[0]
            print(f"⚠️ [Triad Notice] Unsupported file-to-directory transition detected ({first_col} -> {first_col}/...). Preserving recovery patch for manual merge.", file=sys.stderr)
            return False

        baseline_dir_ancestors = _get_ancestor_dirs(baseline_paths)
        dir_to_file_collisions = target_paths.intersection(baseline_dir_ancestors)
        if dir_to_file_collisions:
            first_col = sorted(dir_to_file_collisions)[0]
            print(f"⚠️ [Triad Notice] Unsupported directory-to-file transition detected ({first_col}/... -> {first_col}). Preserving recovery patch for manual merge.", file=sys.stderr)
            return False

        for rel_p in sorted(affected_rel_paths):
            file_p = _validate_and_resolve_contained_path(target_dir, rel_p)
            if file_p is None:
                # Traversal through symlinked parent directory or escape from repository: abort before mutation!
                return False

            existed_at_baseline = rel_p in baseline_tree_entries
            if existed_at_baseline:
                b_mode_str, _, b_sha = baseline_tree_entries[rel_p]
                try:
                    st = os.lstat(file_p)
                    is_link = stat.S_ISLNK(st.st_mode)
                    is_reg = stat.S_ISREG(st.st_mode)
                    is_dir = stat.S_ISDIR(st.st_mode)
                    link_target = os.readlink(file_p) if is_link else None
                    file_bytes = file_p.read_bytes() if is_reg else None
                    entry = {
                        "existed": True,
                        "is_symlink": is_link,
                        "is_regular": is_reg,
                        "is_dir": is_dir,
                        "link_target": link_target,
                        "mode": st.st_mode,
                        "size": st.st_size,
                        "mtime_ns": st.st_mtime_ns,
                        "bytes": file_bytes,
                        "baseline_sha": b_sha,
                        "baseline_mode": int(b_mode_str, 8),
                    }
                except Exception:
                    # File existed in baseline tree but cannot be statted/read from disk
                    return False
            else:
                # Did not exist in baseline tree
                if file_p.is_symlink() or file_p.exists():
                    # Untracked file occupying target path: abort before mutation!
                    return False
                entry = {
                    "existed": False,
                    "is_symlink": False,
                    "is_regular": False,
                    "is_dir": False,
                    "link_target": None,
                    "mode": None,
                    "size": None,
                    "mtime_ns": None,
                    "bytes": None,
                    "baseline_sha": None,
                    "baseline_mode": None,
                }

            # Final target state obtained directly from target_tree_to_verify
            if rel_p in target_tree_entries:
                t_mode_str, _, t_sha = target_tree_entries[rel_p]
                entry["expected_target_exists"] = True
                t_mode_int = int(t_mode_str, 8)
                if existed_at_baseline and entry.get("mode") is not None:
                    # Preserve baseline filesystem permissions (e.g. 0664 vs 0644), adjusting executable bits if git changed them
                    b_git_mode = entry.get("baseline_mode", 0o100644)
                    git_changed_exec = bool(t_mode_int & 0o111) != bool(b_git_mode & 0o111)
                    if not git_changed_exec:
                        entry["target_mode"] = entry["mode"]
                    else:
                        if bool(t_mode_int & 0o111):
                            entry["target_mode"] = entry["mode"] | 0o111
                        else:
                            entry["target_mode"] = entry["mode"] & ~0o111
                else:
                    entry["target_mode"] = t_mode_int

                is_target_link = (t_mode_str == "120000")
                entry["expected_target_is_link"] = is_target_link
                if is_target_link:
                    # Symlinks in git store raw target path strings; never apply checkout filters
                    r_cat, blob_bytes, _ = run_subprocess_tree_safe_bytes(
                        ["git", "cat-file", "blob", t_sha],
                        cwd=target_dir,
                        env=exec_env
                    )
                else:
                    # Apply checkout filters (CRLF, smudge) for rel_p if regular file
                    r_cat, blob_bytes, _ = run_subprocess_tree_safe_bytes(
                        ["git", "cat-file", "--filters", f"--path={rel_p}", t_sha],
                        cwd=target_dir,
                        env=exec_env
                    )
                    if r_cat != 0:
                        r_cat, blob_bytes, _ = run_subprocess_tree_safe_bytes(
                            ["git", "cat-file", "-p", t_sha],
                            cwd=target_dir,
                            env=exec_env
                        )
                if r_cat != 0:
                    return False
                if is_target_link:
                    entry["expected_target_link"] = os.fsdecode(blob_bytes)
                    entry["expected_target_bytes"] = None
                else:
                    entry["expected_target_bytes"] = blob_bytes
                    entry["expected_target_link"] = None
            else:
                entry["expected_target_exists"] = False
                entry["expected_target_bytes"] = None
                entry["expected_target_link"] = None
                entry["expected_target_is_link"] = False
                entry["target_mode"] = None

            backup_entries[file_p] = entry

        # 2. Dry run verify against working tree without modifying index (strictly byte-accurate)
        check_cmd = ["git", "apply", "--check", "--whitespace=nowarn", temp_patch_path]
        check_res = subprocess.run(check_cmd, cwd=str(target_dir), env=exec_env, capture_output=True)
        if check_res.returncode != 0:
            return False

        # 3. Concurrency check: verify no touched file was modified between discovery and apply
        for file_p, info in backup_entries.items():
            if info["existed"]:
                try:
                    cur_st = os.lstat(file_p)
                    if cur_st.st_mtime_ns != info["mtime_ns"] or cur_st.st_size != info["size"]:
                        rec_path = get_recovery_patch_path(target_dir, unique=True)
                        try:
                            write_atomic_patch(rec_path, raw_bytes if raw_bytes.endswith(b"\n") else raw_bytes + b"\n")
                            print(f"[Triad Notice] Concurrent modification detected before apply; preserved recovery patch at {rec_path}", file=sys.stderr)
                        except Exception:
                            pass
                        return False
                except Exception:
                    return False

        # 4. Apply strictly to working tree (NO --index, NO --3way, NO --whitespace=fix)
        application_started = True
        apply_cmd = ["git", "apply", "--whitespace=nowarn", temp_patch_path]
        apply_res = subprocess.run(apply_cmd, cwd=str(target_dir), env=exec_env, capture_output=True)
        if apply_res.returncode != 0:
            rec_path = get_recovery_patch_path(target_dir, unique=True)
            try:
                write_atomic_patch(rec_path, raw_bytes if raw_bytes.endswith(b"\n") else raw_bytes + b"\n")
                print(f"[Triad Notice] Preserved verified recovery patch at {rec_path}", file=sys.stderr)
            except Exception:
                pass
            return False

        # 5. Post-application verification: working tree must match target_tree_to_verify
        post_wt = snapshot_worktree_tree(target_dir, head_tree=target_tree_to_verify, env=exec_env)
        if post_wt == baseline_tree or (target_tree_to_verify and post_wt != target_tree_to_verify):
            # To eliminate destructive races with external editors/writers, do not perform automatic in-place rollback.
            # Preserving the recovery patch artifact leaves workspace files intact without risking editor truncation/unlinking.
            rec_path = get_recovery_patch_path(target_dir, unique=True)
            try:
                write_atomic_patch(rec_path, raw_bytes if raw_bytes.endswith(b"\n") else raw_bytes + b"\n")
                print(f"[Triad Notice] Preserved verified recovery patch at {rec_path}", file=sys.stderr)
            except Exception:
                pass
            return False

        return True
    except Exception:
        if application_started:
            rec_path = get_recovery_patch_path(target_dir, unique=True)
            try:
                write_atomic_patch(rec_path, raw_bytes if raw_bytes.endswith(b"\n") else raw_bytes + b"\n")
                print(f"[Triad Notice] Preserved verified recovery patch at {rec_path}", file=sys.stderr)
            except Exception:
                pass
        return False
    finally:
        try:
            lock_ctx.__exit__(None, None, None)
        except Exception:
            pass
        if os.path.exists(temp_patch_path):
            try:
                os.remove(temp_patch_path)
            except Exception:
                pass

def _exec_subprocess_tree_safe(cmd: List[str], cwd: Path, env: Optional[Dict[str, str]] = None, timeout: int = 90, input_data: Optional[bytes] = None) -> Tuple[int, bytes, bytes]:
    """Execute command returning raw bytes, killing the entire process tree on timeout."""
    proc = None
    exec_env = env if env is not None else clean_git_env()
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            env=exec_env,
            stdin=subprocess.PIPE if input_data is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        stdout, stderr = proc.communicate(input=input_data, timeout=timeout)
        return proc.returncode, stdout, stderr
    except subprocess.TimeoutExpired:
        if proc:
            kill_process_tree(proc.pid)
        return 1, b"", f"Command timed out after {timeout}s (entire process tree killed)".encode("utf-8")
    except Exception as e:
        if proc:
            kill_process_tree(proc.pid)
        return 1, b"", f"Execution error: {e}".encode("utf-8")

def run_subprocess_tree_safe_bytes(cmd: List[str], cwd: Path, env: Optional[Dict[str, str]] = None, timeout: int = 90, input_data: Optional[bytes] = None) -> Tuple[int, bytes, bytes]:
    """Execute command returning raw bytes, killing the entire process tree on timeout."""
    return _exec_subprocess_tree_safe(cmd, cwd=cwd, env=env, timeout=timeout, input_data=input_data)

def run_subprocess_tree_safe(cmd: List[str], cwd: Path, env: Optional[Dict[str, str]] = None, timeout: int = 90, input_data: Optional[bytes] = None) -> Tuple[int, str, str]:
    """Execute command returning strings, killing the entire process tree on timeout."""
    ret, out_b, err_b = _exec_subprocess_tree_safe(cmd, cwd=cwd, env=env, timeout=timeout, input_data=input_data)
    out_str = out_b.decode("utf-8", errors="replace") if isinstance(out_b, bytes) else str(out_b)
    err_str = err_b.decode("utf-8", errors="replace") if isinstance(err_b, bytes) else str(err_b)
    return ret, out_str, err_str

def get_empty_tree_oid(repo_root: Path = Path(".")) -> str:
    """Dynamically determine the empty tree object ID for the repo's object format (SHA-1 or SHA-256)."""
    ret, out, _ = run_subprocess_tree_safe(["git", "hash-object", "-t", "tree", "--stdin"], cwd=repo_root, input_data=b"")
    if ret == 0 and out.strip():
        return out.strip()
    return "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

def query_gate_fix(diag_output: str, args) -> str:
    """
    Query Advisory Council or Competition Council for a surgical fix to a test/build failure.
    """
    fix_prompt = (
        f"The test/build suite failed with this output:\n{diag_output}\n\n"
        "Diagnose the failure and provide the minimal unified diff to fix it."
    )
    competition = getattr(args, "competition", False)
    timeout = getattr(args, "timeout", 240)
    engine = getattr(args, "engine", "auto")

    if competition:
        try:
            from triad.competition import query_competition_council
        except ImportError:
            from competition import query_competition_council
        adv_pair = ("mock", "mock") if engine == "mock" else ("claude", "codex")
        session = query_competition_council(
            fix_prompt,
            mode="debug",
            timeout=timeout,
            advisor_names=adv_pair
        )
        return session.get("synthesis", "")

    return query_advisory_council(fix_prompt, mode="debug", engine=engine, timeout=timeout)

def snapshot_worktree_tree(repo_root: Path, head_tree: str = "", env: Optional[Dict[str, str]] = None) -> str:
    """
    Captures a full git tree snapshot of the working tree (including unstaged and untracked files).
    Uses an isolated temporary index file so the main git index is NEVER modified.
    Snapshots are strictly read-only with respect to checkout files (never invokes git checkout).
    Excludes only provisioned, untracked dependency paths (e.g. untracked node_modules or manifest links)
    while strictly preserving actual working-tree contents of any tracked paths.
    """
    temp_index = Path(tempfile.gettempdir()) / f"triad-wt-{uuid.uuid4().hex[:8]}"
    base_env = env if env is not None else clean_git_env()
    temp_env = clean_git_env({"GIT_INDEX_FILE": str(temp_index)}, base_env=base_env)
    try:
        # Seed temporary index from head_tree or caller's index tree
        seed_tree = head_tree
        if not seed_tree:
            ret_w, out_w, _ = run_subprocess_tree_safe(["git", "write-tree"], cwd=repo_root, env=base_env)
            if ret_w == 0 and out_w.strip():
                seed_tree = out_w.strip()

        tracked_set: Set[str] = set()
        if seed_tree:
            ret, _, err = run_subprocess_tree_safe(["git", "read-tree", seed_tree], cwd=repo_root, env=temp_env)
            if ret != 0:
                raise RuntimeError(f"Failed to initialize snapshot index from {seed_tree}: {err}")
            try:
                tree_entries = get_tree_entries(seed_tree, repo_root, temp_env)
                tracked_set = set(tree_entries.keys())
            except Exception:
                pass
        else:
            ret_ls, out_ls, err_ls = run_subprocess_tree_safe_bytes(["git", "ls-files", "-z"], cwd=repo_root, env=base_env)
            if ret_ls != 0:
                raise RuntimeError(f"Failed to query tracked files for snapshot: {err_ls}")
            tracked_set = set(os.fsdecode(p).replace("\\", "/") for p in out_ls.split(b"\0") if p)

        # Stage working tree to temporary index
        ret, _, err = run_subprocess_tree_safe(["git", "add", "-A"], cwd=repo_root, env=temp_env)
        if ret != 0:
            raise RuntimeError(f"Failed to stage working tree to temporary index: {err}")

        prov_entries = get_provisioned_manifest_entries(repo_root)
        nm_path = Path(repo_root) / "node_modules"
        has_nm = nm_path.exists() or is_reparse_or_link(nm_path)

        paths_to_check: List[str] = list(prov_entries)
        if has_nm and "node_modules" not in paths_to_check:
            paths_to_check.append("node_modules")

        # Exclude ONLY untracked provisioned paths, without modifying any working tree files
        for entry in paths_to_check:
            norm_entry = entry.replace("\\", "/").rstrip("/")
            has_tracked = any(t == norm_entry or t.startswith(norm_entry + "/") for t in tracked_set)
            if not has_tracked:
                # No files under this provisioned entry are tracked: remove entire entry from temp index
                ret_rm, _, err_rm = run_subprocess_tree_safe(["git", "rm", "--cached", "-r", "-f", "--ignore-unmatch", norm_entry], cwd=repo_root, env=temp_env)
                if ret_rm != 0:
                    raise RuntimeError(f"Failed to unstage untracked provisioned entry {norm_entry} from temporary index: {err_rm}")
            else:
                # Tracked files exist under this path; unstage only untracked entries
                ret_ls, out_ls, err_ls = run_subprocess_tree_safe_bytes(["git", "ls-files", "-z", "--stage", norm_entry], cwd=repo_root, env=temp_env)
                if ret_ls != 0:
                    raise RuntimeError(f"Failed to enumerate temporary index entries under {norm_entry}: {err_ls}")
                if out_ls:
                    for item in out_ls.split(b"\x00"):
                        if not item:
                            continue
                        try:
                            _, path_b = item.split(b"\t", 1)
                            p_str = os.fsdecode(path_b).replace("\\", "/")
                            if p_str not in tracked_set:
                                ret_rm, _, err_rm = run_subprocess_tree_safe(["git", "rm", "--cached", "-f", p_str], cwd=repo_root, env=temp_env)
                                if ret_rm != 0:
                                    raise RuntimeError(f"Failed to unstage untracked entry {p_str} from temporary index: {err_rm}")
                        except Exception as e:
                            raise RuntimeError(f"Failed parsing temporary index entry for {norm_entry}: {e}")

        ret, wt_tree, err = run_subprocess_tree_safe(["git", "write-tree"], cwd=repo_root, env=temp_env)
        if ret != 0 or not wt_tree.strip():
            raise RuntimeError(f"Failed to write working tree snapshot: {err}")
        return wt_tree.strip()
    finally:
        if temp_index.exists():
            try:
                temp_index.unlink()
            except Exception:
                pass


def _stage_candidate_worktree_changes(cwd: Path, exec_env: dict, head_tree: str = "") -> None:
    """
    Stage candidate changes in worktree while strictly excluding untracked provisioned
    dependencies (such as node_modules) when .gitignore is absent.
    Preserves tracked files and unstaged edits to tracked files.
    """
    ret, _, err = run_subprocess_tree_safe(["git", "add", "-A"], cwd=cwd, env=exec_env)
    if ret != 0:
        raise RuntimeError(f"Failed to stage healed changes: {err.strip()}")

    tracked_set: Set[str] = set()
    if head_tree:
        try:
            tree_entries = get_tree_entries(head_tree, cwd, env=exec_env)
            tracked_set = set(tree_entries.keys())
        except Exception:
            pass

    prov_entries = get_provisioned_manifest_entries(cwd)
    nm_path = Path(cwd) / "node_modules"
    has_nm = nm_path.exists() or is_reparse_or_link(nm_path)

    paths_to_check: List[str] = list(prov_entries)
    if has_nm and "node_modules" not in paths_to_check:
        paths_to_check.append("node_modules")

    for entry in paths_to_check:
        norm_entry = entry.replace("\\", "/").rstrip("/")
        has_tracked = any(t == norm_entry or t.startswith(norm_entry + "/") for t in tracked_set)
        if not has_tracked:
            ret_rm, _, err_rm = run_subprocess_tree_safe(["git", "rm", "--cached", "-r", "-f", "--ignore-unmatch", norm_entry], cwd=cwd, env=exec_env)
            if ret_rm != 0:
                raise RuntimeError(f"Failed to unstage untracked provisioned entry {norm_entry}: {err_rm.strip()}")
        else:
            ret_ls, out_ls, _ = run_subprocess_tree_safe_bytes(["git", "ls-files", "-z", "--stage", norm_entry], cwd=cwd, env=exec_env)
            if ret_ls == 0 and out_ls:
                for item in out_ls.split(b"\x00"):
                    if not item:
                        continue
                    try:
                        _, path_b = item.split(b"\t", 1)
                        p_str = os.fsdecode(path_b).replace("\\", "/")
                        if p_str not in tracked_set:
                            ret_rm, _, _ = run_subprocess_tree_safe(["git", "rm", "--cached", "-f", p_str], cwd=cwd, env=exec_env)
                            if ret_rm != 0:
                                raise RuntimeError(f"Failed to unstage untracked file {p_str}")
                    except Exception:
                        pass


def compute_working_tree_fingerprint(cwd: Path, env: Optional[Dict[str, str]] = None) -> Dict[str, Tuple[int, int, str, str]]:
    """
    Capture byte-for-byte filesystem fingerprint (st_size, st_mtime_ns, sha256, mode) of all tracked
    and working tree files to detect raw mutations and mode changes that Git clean/smudge filters might normalize away.
    Returns rel_path -> (st_size, st_mtime_ns, content_hash, mode_str).
    Raises RuntimeError on git enumeration failure or unexpected file access/read errors (fail-closed).
    """
    exec_env = env if env is not None else clean_git_env()

    # Capture staged index modes to track executable bit changes on platforms with core.fileMode=false
    stage_modes: Dict[str, str] = {}
    ret_s, out_s, _ = run_subprocess_tree_safe_bytes(["git", "ls-files", "-z", "--stage"], cwd=cwd, env=exec_env)
    if ret_s == 0 and out_s:
        for entry in out_s.split(b"\x00"):
            if not entry:
                continue
            try:
                meta, path_b = entry.split(b"\t", 1)
                st_mode_str = meta.split(b" ")[0].decode("ascii", errors="replace")
                stage_modes[os.fsdecode(path_b)] = st_mode_str
            except Exception:
                pass

    prov_entries = get_provisioned_manifest_entries(cwd)
    prov_set = set(prov_entries)

    ret, out, err = run_subprocess_tree_safe_bytes(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=cwd, env=exec_env)
    if ret != 0:
        err_msg = err.decode("utf-8", errors="replace") if isinstance(err, bytes) else str(err)
        raise RuntimeError(f"git ls-files failed during fingerprint computation: {err_msg.strip()}")
    fingerprint: Dict[str, Tuple[int, int, str, str]] = {}
    for p_bytes in out.split(b"\x00"):
        if not p_bytes:
            continue
        rel_p = os.fsdecode(p_bytes).replace("\\", "/")
        is_tracked = rel_p in stage_modes
        if not is_tracked:
            if rel_p == "node_modules" or rel_p.startswith("node_modules/") or rel_p in prov_set:
                continue
        abs_p = cwd / rel_p
        try:
            st = os.lstat(abs_p)
            if stage_modes.get(rel_p) == "160000" or (stat.S_ISDIR(st.st_mode) and (abs_p / ".git").exists()):
                # Submodule certification in fingerprint
                ret_sub, sub_head, err_sub = run_subprocess_tree_safe(["git", "-C", str(abs_p), "rev-parse", "HEAD"], cwd=cwd, env=exec_env)
                if ret_sub != 0 or not sub_head.strip():
                    raise RuntimeError(f"Submodule {rel_p} rev-parse failed: {err_sub.strip()}")
                ret_stat, sub_stat, err_stat = run_subprocess_tree_safe(["git", "-C", str(abs_p), "status", "--porcelain"], cwd=cwd, env=exec_env)
                if ret_stat != 0:
                    raise RuntimeError(f"Submodule {rel_p} status inspection failed: {err_stat.strip()}")
                fingerprint[rel_p] = (0, st.st_mtime_ns, f"submodule:{sub_head.strip()}:{sub_stat.strip()}", "160000")
                continue

            if os.name != "nt":
                if stat.S_ISLNK(st.st_mode):
                    mode_str = "120000"
                elif (st.st_mode & 0o111) != 0:
                    mode_str = "100755"
                else:
                    mode_str = "100644"
            else:
                if stat.S_ISLNK(st.st_mode) or (hasattr(os.path, "isjunction") and os.path.isjunction(str(abs_p))):
                    mode_str = "120000"
                elif rel_p in stage_modes:
                    mode_str = stage_modes[rel_p]
                else:
                    mode_str = "100644"

            if stat.S_ISREG(st.st_mode):
                content = abs_p.read_bytes()
                h = hashlib.sha256(content).hexdigest()
                fingerprint[rel_p] = (st.st_size, st.st_mtime_ns, h, mode_str)
            elif stat.S_ISLNK(st.st_mode):
                link_target = os.readlink(abs_p)
                fingerprint[rel_p] = (0, st.st_mtime_ns, f"link:{link_target}", mode_str)
            else:
                fingerprint[rel_p] = (st.st_size, st.st_mtime_ns, "other", mode_str)
        except FileNotFoundError:
            fingerprint[rel_p] = (0, 0, "missing", "000000")
        except Exception as e:
            raise RuntimeError(f"Failed to inspect working-tree file {rel_p}: {e}")
    return fingerprint


def fingerprints_match(f1: Dict[str, Any], f2: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Compare two working tree fingerprints, returning (matches, list_of_differences)."""
    mutated = []
    for rel_p, v1 in f1.items():
        if rel_p not in f2:
            mutated.append(f"D\t{rel_p}")
        else:
            v2 = f2[rel_p]
            s1, _m1, h1 = v1[0], v1[1], v1[2]
            mode1 = v1[3] if len(v1) > 3 else None
            s2, _m2, h2 = v2[0], v2[1], v2[2]
            mode2 = v2[3] if len(v2) > 3 else None
            if s1 != s2 or h1 != h2 or (mode1 is not None and mode2 is not None and mode1 != mode2):
                desc = f"M\t{rel_p}"
                if mode1 is not None and mode2 is not None and mode1 != mode2:
                    desc += f" (mode changed: {mode1} -> {mode2})"
                mutated.append(desc)
    for rel_p in f2:
        if rel_p not in f1:
            mutated.append(f"A\t{rel_p}")
    return len(mutated) == 0, mutated


def capture_parent_state(repo_root: Path, env: Optional[Dict[str, str]] = None, require_index: bool = False) -> Dict[str, Any]:
    """
    Captures the complete state of parent repository:
    - candidate_tree: tree object representing the commit candidate
    - index_tree: current index tree (preserving GIT_INDEX_FILE if in env)
    - wt_tree: full working-tree snapshot (unstaged + untracked)
    - has_changes: bool
    - is_unborn: bool
    """
    exec_env = env if env is not None else os.environ

    # 1. Attempt writing current index tree (preserving alternate GIT_INDEX_FILE if provided)
    ret, index_tree, err = run_subprocess_tree_safe(["git", "write-tree"], cwd=repo_root, env=exec_env)
    if ret != 0:
        raise RuntimeError(f"Failed to capture parent index tree: {err}")
    index_tree = index_tree.strip()

    # Get HEAD commit OID and tree sha
    ret_commit, head_commit, _ = run_subprocess_tree_safe(["git", "rev-parse", "--verify", "HEAD"], cwd=repo_root, env=exec_env)
    head_commit = head_commit.strip() if ret_commit == 0 else "UNBORN"

    ret, head_tree, err = run_subprocess_tree_safe(["git", "rev-parse", "HEAD^{tree}"], cwd=repo_root, env=exec_env)
    if ret != 0:
        head_tree = ""
    else:
        head_tree = head_tree.strip()

    empty_tree_oid = get_empty_tree_oid(repo_root)
    is_unborn = not bool(head_tree)

    # 2. Snapshot working tree contents seeded from index_tree so newly staged ignored files are tracked
    wt_tree = snapshot_worktree_tree(repo_root, head_tree=index_tree, env=exec_env)

    # Staged changes exist if index differs from HEAD (or unborn index is non-empty)
    has_staged = (bool(head_tree) and index_tree != head_tree) or (is_unborn and index_tree != empty_tree_oid)
    has_unstaged = (wt_tree != index_tree)
    has_changes = has_staged or has_unstaged

    # Commit gating strictly commits index_tree when require_index is True.
    # Working-tree candidate selection is used for non-commit commands (e.g. triad auto intent execution).
    candidate_tree = index_tree if require_index else wt_tree

    return {
        "candidate_tree": candidate_tree,
        "index_tree": index_tree,
        "wt_tree": wt_tree,
        "head_tree": head_tree,
        "head_commit": head_commit,
        "has_changes": has_changes,
        "is_unborn": is_unborn,
        "has_staged": has_staged,
        "has_unstaged": has_unstaged
    }

def capture_candidate_tree(repo_root: Path, env: Optional[Dict[str, str]] = None, require_index: bool = False) -> Tuple[str, bool]:
    """
    Captures the exact candidate git tree object for verification.
    Preserves GIT_INDEX_FILE when present in env (e.g. from git pre-commit hook).
    Returns (candidate_tree, has_changes).
    Raises RuntimeError on git failures (fail-closed).
    """
    state = capture_parent_state(repo_root, env=env, require_index=require_index)
    return state["candidate_tree"], state["has_changes"]

def get_recovery_patch_path(repo_root: Path, unique: bool = False) -> Path:
    """Resolve recovery patch path inside git directory so working directory is never polluted."""
    filename = f"triad_recovery_{int(time.time())}_{uuid.uuid4().hex[:8]}.patch" if unique else "triad_recovery.patch"
    ret, out, _ = run_subprocess_tree_safe(["git", "rev-parse", "--git-path", filename], cwd=repo_root)
    if ret == 0 and out.strip():
        p = Path(out.strip())
        if not p.is_absolute():
            p = (Path(repo_root) / p).resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    git_dir = Path(repo_root) / ".git"
    if git_dir.is_dir():
        return git_dir / filename
    return Path(repo_root) / f".{filename}"

def write_atomic_patch(target_path: Path, data: bytes):
    """Write patch bytes atomically to target path; raises on error."""
    tmp_path = target_path.with_suffix(f".tmp.{uuid.uuid4().hex[:8]}")
    tmp_path.write_bytes(data)
    os.replace(str(tmp_path), str(target_path))


def sanitize_worktree_env(
    env: Dict[str, str],
    repo_root: Union[str, Path],
    worktree_path: Optional[Union[str, Path]] = None,
) -> Dict[str, str]:
    """
    Establish strict worktree environment isolation:
    - Sets TRIAD_ISOLATED_WORKTREE="1"
    - Sets NODE_PRESERVE_SYMLINKS="1"
    - Strips parent repo_root (and uncontained descendants) from PYTHONPATH
    - Prepends worktree_path to PYTHONPATH if provided
    """
    iso_env = dict(env)
    iso_env["TRIAD_ISOLATED_WORKTREE"] = "1"
    iso_env["NODE_PRESERVE_SYMLINKS"] = "1"

    # Ensure Node resolves module dependencies in symlink-preserved mode without breaking CLI main relative imports
    orig_node_opts = iso_env.get("NODE_OPTIONS", "")
    if "--preserve-symlinks" not in orig_node_opts:
        iso_env["NODE_OPTIONS"] = (orig_node_opts + " --preserve-symlinks").strip()

    clean_repo = Path(repo_root).resolve()
    clean_wt = Path(worktree_path).resolve() if worktree_path is not None else None

    orig_pp = iso_env.get("PYTHONPATH", "")
    sanitized_parts: List[str] = []
    if clean_wt is not None:
        sanitized_parts.append(str(clean_wt))

    if orig_pp:
        for part in orig_pp.split(os.pathsep):
            if not part:
                continue
            try:
                p = Path(part).resolve()
                is_venv = any(seg.lower() in ("site-packages", "dist-packages") for seg in p.parts)
                is_parent = (p == clean_repo or clean_repo in p.parents)
                is_in_wt = clean_wt is not None and (p == clean_wt or clean_wt in p.parents)
                if is_parent and not is_in_wt and not is_venv:
                    continue
                if str(p) not in sanitized_parts:
                    sanitized_parts.append(str(p))
            except Exception:
                pass

    iso_env["PYTHONPATH"] = os.pathsep.join(sanitized_parts)
    return iso_env


def _notice_recovery_patch(recovery_path: Optional[Path]) -> None:
    if recovery_path and recovery_path.exists():
        print(f"[Triad Notice] Preserved verified self-healing patch at {recovery_path}")


def _is_ci(env: Optional[Dict[str, str]] = None) -> bool:
    """Return True if running in a Continuous Integration environment (GitHub Actions, GitLab, etc.)."""
    exec_env = os.environ if env is None else env
    return str(exec_env.get("CI", "")).strip().lower() in ("1", "true", "yes")


def _normalize_single_target(raw: str) -> str:
    """Normalize a single target test pattern or file path into a test pattern (e.g. 'test_*.py')."""
    s = (raw or "").strip().replace("\\", "/")
    base = os.path.basename(s)
    if not base or base == "test_*.py":
        return "test_*.py"
    if s.endswith("/") or base in ("tests", "test"):
        return "test_*.py"
    if "*" in base:
        if not base.startswith("test_"):
            return f"test_{base}" if base.endswith(".py") else f"test_{base}.py"
        return base if base.endswith(".py") else f"{base}.py"
    if not base.startswith("test_"):
        stem = base[:-3] if base.endswith(".py") else base
        base = f"test_{stem}.py"
    elif not base.endswith(".py"):
        base = f"{base}.py"
    return base


def _normalize_target(raw: str) -> str:
    """Normalize target test pattern(s) or file paths into test pattern(s) (e.g. 'test_*.py' or 'test_a.py,test_b.py')."""
    if not raw or not raw.strip():
        return "test_*.py"
    raw_str = raw.strip()
    if "," in raw_str:
        parts = [_normalize_single_target(p) for p in raw_str.split(",") if p.strip()]
        if any(p == "test_*.py" for p in parts) or not parts:
            return "test_*.py"
        return ",".join(sorted(set(parts)))
    return _normalize_single_target(raw_str)


def _check_apply_verified_safety(args, env: Optional[Dict[str, str]] = None) -> None:
    exec_env = os.environ if env is None else env
    if _is_ci(exec_env):
        return
    raw_target = getattr(args, "target", "") or exec_env.get("TRIAD_TEST_TARGET", "")
    norm_target = _normalize_target(raw_target)
    is_targeted_req = bool(
        (norm_target != "test_*.py")
        or getattr(args, "targeted", False)
        or exec_env.get("TRIAD_TARGETED_TESTS") == "1"
    )
    if getattr(args, "apply_verified", False) and is_targeted_req:
        env_hint = " (via TRIAD_TARGETED_TESTS environment variable)" if exec_env.get("TRIAD_TARGETED_TESTS") == "1" else ""
        print(
            f"\n[Triad Gate Error] Cannot use --apply-verified with targeted test execution (--target / --targeted){env_hint}.\n"
            "A full test suite run is required before applying verified changes back to parent repository.",
            file=sys.stderr,
        )
        sys.exit(1)


def _run_in_isolated_worktree(
    args,
    env: Optional[Dict[str, str]],
    *,
    repo_root: Union[str, Path],
    prefix: str,
    require_index: bool,
    runner,
    error_label: str,
    phase_label: str,
    nm_phase_label: str,
    enforce_clean_explicit_ref: bool,
    pause_commit_after_apply: bool,
    notify_async: bool,
) -> None:
    """
    Shared orchestration for ``--worktree`` execution used by both ``triad gate`` and
    ``triad auto``. The lifecycle is:

      1. Snapshot the parent repository (HEAD, index tree, working-tree tree).
      2. Spawn an ephemeral worktree, materialize the candidate tree, provision deps.
      3. Run ``runner(isolated_args, isolated_env)`` inside it.
      4. If the run self-healed, extract a binary tree-to-tree patch and persist it to
         a recovery file under ``.git`` *before* the worktree is torn down.
      5. Re-verify the parent did not mutate concurrently (HEAD / index / working tree).
      6. Optionally (``--apply-verified``) apply the patch to the parent working tree.

    Every failure path exits non-zero (fail-closed). Parameters that differ between
    callers are the worktree ``prefix``, whether the candidate is the index
    (``require_index``, commit gating) or the working tree, the user-facing labels,
    whether an explicit ``--ref`` is rejected on a dirty parent, and whether a
    successfully applied patch pauses the commit (gate) or simply continues (auto).
    """
    base_env = env if env is not None else os.environ
    _check_apply_verified_safety(args, base_env)
    ref = getattr(args, "ref", "HEAD") or "HEAD"
    apply_verified = getattr(args, "apply_verified", False)

    try:
        parent_state = capture_parent_state(repo_root, env=base_env, require_index=require_index)
        candidate_tree = parent_state["candidate_tree"]
        initial_index_tree = parent_state["index_tree"]
        initial_wt_tree = parent_state["wt_tree"]
        initial_head_commit = parent_state.get("head_commit", "UNBORN")
        has_changes = parent_state["has_changes"]
        is_unborn = parent_state["is_unborn"]
    except Exception as e:
        print(f"\n❌ [Triad Worktree Error] Failed to capture candidate parent state: {e}", file=sys.stderr)
        sys.exit(1)

    is_explicit_ref = False
    transfer_local_changes = True
    if enforce_clean_explicit_ref:
        is_explicit_ref = bool(getattr(args, "ref", None) and getattr(args, "ref") != "HEAD")
        if is_explicit_ref and has_changes:
            print(f"\n❌ [Triad Auto Error] Cannot run 'triad auto --ref {ref}' with uncommitted local changes in working directory or staged index.", file=sys.stderr)
            print("To fix: Commit or stash local changes, or omit '--ref' to operate on current working tree state.", file=sys.stderr)
            sys.exit(1)
        transfer_local_changes = has_changes or (not is_explicit_ref and not is_unborn)

    empty_tree_oid = get_empty_tree_oid(Path(repo_root))
    isolated_env = clean_git_env(base_env=env)
    isolated_env = sanitize_worktree_env(isolated_env, repo_root)

    if is_unborn:
        review_base = empty_tree_oid
    elif is_explicit_ref and not has_changes:
        ret_base, base_rev_tree, _ = run_subprocess_tree_safe(["git", "rev-parse", f"{ref}~1^{{tree}}"], cwd=repo_root, env=isolated_env)
        review_base = base_rev_tree.strip() if ret_base == 0 and base_rev_tree.strip() else empty_tree_oid
    else:
        review_base = parent_state.get("head_tree") or ref

    # In an unborn repository, HEAD does not exist, so git worktree add HEAD will fail.
    # We materialize a temporary commit object from candidate_tree to anchor the worktree.
    if is_unborn:
        ret, temp_commit, err = run_subprocess_tree_safe(["git", "commit-tree", candidate_tree, "-m", "triad-temp-unborn-init"], cwd=repo_root, env=isolated_env)
        if ret != 0 or not temp_commit.strip():
            print(f"\n❌ [Triad Worktree Error] Failed to create temporary root commit for unborn repo: {err}", file=sys.stderr)
            sys.exit(1)
        ref_to_use = temp_commit.strip()
    else:
        ref_to_use = ref

    print(f"[Triad Worktree] Spawning isolated ephemeral git worktree from {repo_root} (ref: {ref_to_use[:10]})...")

    verified_patch_to_apply: Optional[bytes] = None
    recovery_path: Optional[Path] = None
    validated_tree: Optional[str] = None

    with isolated_worktree(repo_root, branch_or_commit=ref_to_use, prefix=prefix, cd=True, env=isolated_env) as wt:
        print(f"[Triad Worktree] Active in: {wt}")
        isolated_env = sanitize_worktree_env(isolated_env, repo_root, wt)
        if transfer_local_changes and not is_unborn:
            print(f"[Triad Worktree] Materializing candidate tree snapshot ({candidate_tree[:10]}) into isolated worktree...")
            ret, _, err = run_subprocess_tree_safe(["git", "read-tree", "-u", "--reset", candidate_tree], cwd=wt, env=isolated_env)
            if ret != 0:
                print(f"\n❌ [Triad Worktree Error] Failed to materialize candidate tree in isolated worktree: {err}", file=sys.stderr)
                sys.exit(1)

            # Verify exact tree parity in isolated worktree (fail-closed)
            ret, wt_tree, err = run_subprocess_tree_safe(["git", "write-tree"], cwd=wt, env=isolated_env)
            if ret != 0 or wt_tree.strip() != candidate_tree:
                print(f"\n❌ [Triad Worktree Error] Worktree tree mismatch (expected {candidate_tree}, got {wt_tree.strip()}): {err}", file=sys.stderr)
                sys.exit(1)

        # Set base_tree directly from worktree index write-tree
        ret, base_tree, err = run_subprocess_tree_safe(["git", "write-tree"], cwd=wt, env=isolated_env)
        if ret != 0 or not base_tree.strip():
            print(f"\n❌ [Triad Worktree Error] Failed to capture worktree base tree: {err}", file=sys.stderr)
            sys.exit(1)
        base_tree = base_tree.strip()

        # Preserve symlinks during Node.js resolution to prevent escaping to parent workspace
        isolated_env["NODE_PRESERVE_SYMLINKS"] = "1"

        # Capture parent node_modules baseline to detect unauthorized validator mutations
        parent_nm = Path(repo_root) / "node_modules"
        parent_nm_snapshot = capture_directory_snapshot(parent_nm)

        # Provision non-tracked external dependencies (e.g. node_modules) from parent repository
        prov = provision_worktree_dependencies(repo_root, wt)
        if prov:
            print(f"[Triad Worktree] Provisioned dependencies: {', '.join(prov)}")

        isolated_args = argparse.Namespace(**vars(args))
        setattr(isolated_args, "worktree", False)
        setattr(isolated_args, "_in_worktree", True)
        setattr(isolated_args, "_originating_root", str(Path(repo_root).resolve()))
        setattr(isolated_args, "_review_base", review_base)
        setattr(isolated_args, "_self_healed_patches", [])
        setattr(isolated_args, "_validated_tree", None)

        try:
            runner(isolated_args, isolated_env)
        finally:
            if hasattr(isolated_args, "_active_test_pattern"):
                setattr(args, "_active_test_pattern", getattr(isolated_args, "_active_test_pattern"))
            # Fail closed if parent node_modules was mutated or deleted by validators
            if parent_nm_snapshot is not None:
                post_nm_snapshot = capture_directory_snapshot(parent_nm)
                if post_nm_snapshot != parent_nm_snapshot:
                    print(f"\n❌ [Triad Worktree Error] Parent node_modules was mutated or deleted during {nm_phase_label} in isolated worktree.", file=sys.stderr)
                    sys.exit(1)

        # Generate single cohesive binary tree-to-tree diff from candidate tree to validated final state
        healed = getattr(isolated_args, "_self_healed_patches", [])
        if healed:
            validated_tree = getattr(isolated_args, "_validated_tree", None)
            if not validated_tree:
                print("\n❌ [Triad Worktree Error] Self-healing succeeded but validated tree was not captured.", file=sys.stderr)
                sys.exit(1)

            diff_cmd = [
                "git", "diff",
                "--binary", "--full-index",
                "--no-color",
                "--no-ext-diff", "--no-textconv",
                "--src-prefix=a/", "--dst-prefix=b/",
                base_tree, validated_tree, "--"
            ]
            ret, final_diff, err = run_subprocess_tree_safe_bytes(diff_cmd, cwd=wt, env=isolated_env)
            if ret != 0 or not final_diff.strip():
                err_msg = err.decode("utf-8", errors="replace") if isinstance(err, bytes) else str(err)
                print(f"\n❌ [Triad Worktree Error] Failed to extract verified patch delta from baseline: {err_msg}", file=sys.stderr)
                sys.exit(1)
            verified_patch_to_apply = final_diff if final_diff.endswith(b"\n") else final_diff + b"\n"
            recovery_path = get_recovery_patch_path(Path(repo_root), unique=True)
            try:
                write_atomic_patch(recovery_path, verified_patch_to_apply)
            except Exception as e:
                print(f"\n❌ [Triad Worktree Error] Failed to persist verified recovery patch before teardown: {e}", file=sys.stderr)
                sys.exit(1)

    print("[Triad Worktree] Ephemeral worktree cleanly removed and unlinked.")

    # Concurrency check on parent repository: verify HEAD, index, AND working tree did not mutate
    try:
        current_state = capture_parent_state(repo_root, env=base_env, require_index=require_index)
        if current_state.get("head_commit") != initial_head_commit:
            _notice_recovery_patch(recovery_path)
            print(f"\n❌ [{error_label}] Concurrent modification detected: parent git HEAD changed during {phase_label} (expected {initial_head_commit[:10]}, current {current_state.get('head_commit', '')[:10]}).", file=sys.stderr)
            sys.exit(1)
        if current_state["index_tree"] != initial_index_tree:
            _notice_recovery_patch(recovery_path)
            print(f"\n❌ [{error_label}] Concurrent modification detected: parent git index changed during {phase_label} (expected {initial_index_tree[:10]}, current {current_state['index_tree'][:10]}).", file=sys.stderr)
            sys.exit(1)
        if current_state["wt_tree"] != initial_wt_tree:
            _notice_recovery_patch(recovery_path)
            print(f"\n❌ [{error_label}] Concurrent modification detected: parent working tree modified during {phase_label}.", file=sys.stderr)
            sys.exit(1)
    except SystemExit:
        raise
    except Exception as e:
        _notice_recovery_patch(recovery_path)
        print(f"\n❌ [{error_label}] Failed concurrency re-verification of parent state: {e}", file=sys.stderr)
        sys.exit(1)

    if not verified_patch_to_apply:
        return

    if current_state["wt_tree"] != base_tree:
        _notice_recovery_patch(recovery_path)
        print(f"\n❌ [{error_label}] Workspace working tree baseline differs from verified worktree baseline (expected {base_tree[:10]}, current {current_state['wt_tree'][:10]}).", file=sys.stderr)
        sys.exit(1)

    patch_bytes = verified_patch_to_apply if isinstance(verified_patch_to_apply, bytes) else verified_patch_to_apply.encode("utf-8")
    line_count = len(patch_bytes.splitlines())

    if not apply_verified:
        print("\n[Triad Closed Loop Note] A verified self-healing patch was produced in the worktree.")
        if recovery_path and recovery_path.exists():
            print(f"[Triad Notice] Preserved verified recovery patch at {recovery_path}")
        print("Run with '--apply-verified' to automatically merge passing self-healing fixes into your main workspace.")
        sys.exit(1)

    print(f"\n[Triad Closed Loop] Applying verified self-healing patch to main working tree ({line_count} lines)...")
    applied = apply_verified_patch_to_workspace(
        patch_bytes,
        cwd=Path(repo_root),
        expected_baseline_tree=base_tree,
        expected_target_tree=validated_tree
    )
    if not applied:
        print("! Error: Could not cleanly merge verified patch back to main working tree.")
        if recovery_path and recovery_path.exists():
            print(f"[Triad Notice] Preserved verified recovery patch at {recovery_path}")
        notify_event("Patch Merge Conflict", "Could not cleanly merge verified patch back to main working tree.", status="failed", timeout=1.5, async_dispatch=notify_async)
        sys.exit(1)

    try:
        post_apply_state = capture_parent_state(repo_root, env=base_env, require_index=False)
        if post_apply_state["index_tree"] != initial_index_tree:
            print("\n❌ [Triad Closed Loop Error] Git index unexpectedly modified during patch application.", file=sys.stderr)
            sys.exit(1)
    except SystemExit:
        raise
    except Exception as e:
        print(f"\n❌ [Triad Closed Loop Error] Failed to verify post-apply repository state: {e}", file=sys.stderr)
        sys.exit(1)

    print("✓ Successfully applied verified patch to working tree!")
    notify_event("Self-Healing Patch Applied", f"Merged {line_count} lines of verified fixes to main workspace.", status="success", timeout=1.5, async_dispatch=notify_async)
    print("\n[Triad Closed Loop Notice] A self-healing patch was applied to your working tree.")
    if pause_commit_after_apply:
        print("To ensure verified code is committed, the commit is paused. Please stage the changes (e.g. 'git add .') and commit again.")
        sys.exit(1)


def cmd_gate(args, env: Optional[Dict[str, str]] = None):
    """
    Ground-Truth Verification Gate with self-healing retry loop:
    1. TypeScript compilation (tsc --noEmit)
    2. Test suites (npm test, Python unittests)
    3. Advisory Council diff review & pre-commit signoff
    If Step 1 or Step 2 fails, queries Advisory Council in debug mode for surgical fix,
    applies patch via git apply, and retries up to --max-retries times.
    Supports isolated worktree execution via --worktree (-w).
    """
    try:
        repo_root = get_repo_root(".", env=env)
    except Exception as e:
        print(f"[Triad Gate Error] Not inside a git repository: {e}", file=sys.stderr)
        sys.exit(1)

    exec_env = os.environ if env is None else env
    _check_apply_verified_safety(args, exec_env)

    if getattr(args, "worktree", False):
        _run_in_isolated_worktree(
            args, env,
            repo_root=repo_root,
            prefix="triad-gate",
            require_index=True,
            runner=lambda a, e: _run_gate(a, env=e, in_worktree=True, review_base=a._review_base),
            error_label="Triad Gate Error",
            phase_label="validation",
            nm_phase_label="gate validation",
            enforce_clean_explicit_ref=False,
            pause_commit_after_apply=True,
            notify_async=True,
        )
    else:
        _run_gate(args, env=env, in_worktree=False, cwd=Path(repo_root))

    active_pat = getattr(args, "_active_test_pattern", None)
    pat_detail = f" (targeted: {active_pat})" if active_pat and active_pat != "test_*.py" else ""
    notify_event("Pre-Commit Gate Passed", f"Type safety, test suites{pat_detail}, and Advisory Council review approved.", status="success", timeout=1.5, async_dispatch=True)


def _render_unittest_suite_runner(target_repr: str, patterns_repr: str, pattern_desc_repr: str) -> str:
    """Generate shared unittest discovery, test ID deduplication, and runner execution block."""
    return (
        "import unittest\n"
        "loader = unittest.defaultTestLoader\n"
        "suite = unittest.TestSuite()\n\n"
        "def _iter_tests(suite_or_case):\n"
        "    if hasattr(suite_or_case, '__iter__'):\n"
        "        for _s in suite_or_case:\n"
        "            yield from _iter_tests(_s)\n"
        "    else:\n"
        "        yield suite_or_case\n\n"
        "seen_ids = set()\n"
        "unmatched = []\n"
        f"for _pat in {patterns_repr}:\n"
        f"    _sub = loader.discover(start_dir={target_repr}, pattern=_pat)\n"
        "    _matched = False\n"
        "    for _case in _iter_tests(_sub):\n"
        "        _tid = getattr(_case, 'id', lambda: str(_case))()\n"
        "        if _tid not in seen_ids:\n"
        "            seen_ids.add(_tid)\n"
        "            suite.addTest(_case)\n"
        "            _matched = True\n"
        "    if not _matched:\n"
        "        unmatched.append(_pat)\n\n"
        "if suite.countTestCases() == 0:\n"
        f"    print('[Triad Test Error] No tests matched pattern(s) ' + {pattern_desc_repr} + ' in ' + {target_repr}, file=sys.stderr)\n"
        "    sys.exit(5)\n"
        "if unmatched:\n"
        f"    print('[Triad Test Warning] Pattern(s) with 0 matches in ' + {target_repr} + ': ' + ', '.join(unmatched), file=sys.stderr)\n\n"
        "runner = unittest.TextTestRunner(verbosity=2)\n"
        "result = runner.run(suite)\n"
        "sys.exit(0 if result.wasSuccessful() else 1)\n"
    )


def _build_python_isolation_script(cwd: Path, py_test_target: str, excluded_roots: List[Path], pattern: Union[str, List[str], Set[str]] = "test_*.py") -> str:
    """Generate isolation script for running Python tests in worktree without leaking parent or originating checkouts."""
    if isinstance(pattern, str):
        if "," in pattern:
            patterns = [p.strip() for p in pattern.split(",") if p.strip()]
        else:
            patterns = [pattern.strip()]
    elif isinstance(pattern, (list, tuple, set)):
        patterns = [str(p).strip() for p in pattern if str(p).strip()]
    else:
        patterns = ["test_*.py"]
    if not patterns:
        patterns = ["test_*.py"]

    excluded_roots_repr = repr([str(r.resolve()) for r in excluded_roots])
    cwd_root_repr = repr(str(cwd.resolve()))
    test_target_repr = repr(py_test_target)
    patterns_repr = repr(patterns)
    pattern_desc_repr = repr(", ".join(patterns))
    return (
        "import sys\n\n"
        f"_ex_roots_raw = tuple({excluded_roots_repr})\n"
        f"_cwd_root_raw = {cwd_root_repr}\n\n"
        "def _norm_path(p):\n"
        "    if not p:\n"
        "        return ''\n"
        "    p = p.replace('\\\\', '/').rstrip('/')\n"
        "    return p.lower() if sys.platform == 'win32' else p\n\n"
        "_ex_norms = tuple(_norm_path(r) for r in _ex_roots_raw if _norm_path(r))\n"
        "_cwd_norm = _norm_path(_cwd_root_raw)\n\n"
        "def _is_boot_venv(p):\n"
        "    np = _norm_path(p)\n"
        "    if '/site-packages' not in np and '/dist-packages' not in np:\n"
        "        return False\n"
        "    import os\n"
        "    cur = p\n"
        "    for _ in range(10):\n"
        "        if os.path.isfile(os.path.join(cur, 'pyvenv.cfg')):\n"
        "            return True\n"
        "        parent = os.path.dirname(cur)\n"
        "        if parent == cur:\n"
        "            break\n"
        "        cur = parent\n"
        "    return False\n\n"
        "_boot_path = []\n"
        "for _p in sys.path:\n"
        "    if not _p:\n"
        "        continue\n"
        "    _np = _norm_path(_p)\n"
        "    if (_np == _cwd_norm) or (_cwd_norm and _np.startswith(_cwd_norm + '/')):\n"
        "        _boot_path.append(_p)\n"
        "    elif any(_np == _ex or _np.startswith(_ex + '/') for _ex in _ex_norms):\n"
        "        if _is_boot_venv(_p):\n"
        "            _boot_path.append(_p)\n"
        "        else:\n"
        "            continue\n"
        "    else:\n"
        "        _boot_path.append(_p)\n"
        "sys.path = [_cwd_root_raw] + [p for p in _boot_path if _norm_path(p) != _cwd_norm]\n\n"
        "import os, pathlib, site, sysconfig\n\n"
        f"excluded_roots = [pathlib.Path(p).resolve() for p in {excluded_roots_repr}]\n"
        f"cwd_root = pathlib.Path({cwd_root_repr}).resolve()\n\n"
        "allowed_dep_dirs = set()\n"
        "try:\n"
        "    for p in site.getsitepackages():\n"
        "        allowed_dep_dirs.add(pathlib.Path(p).resolve())\n"
        "except Exception:\n"
        "    pass\n"
        "try:\n"
        "    usp = site.getusersitepackages()\n"
        "    if usp:\n"
        "        allowed_dep_dirs.add(pathlib.Path(usp).resolve())\n"
        "except Exception:\n"
        "    pass\n"
        "try:\n"
        "    for k in ('stdlib', 'platstdlib', 'purelib', 'platlib'):\n"
        "        pth = sysconfig.get_path(k)\n"
        "        if pth:\n"
        "            allowed_dep_dirs.add(pathlib.Path(pth).resolve())\n"
        "except Exception:\n"
        "    pass\n"
        "def _is_allowed_dep(p: pathlib.Path) -> bool:\n"
        "    if any(dep == p or dep in p.parents for dep in allowed_dep_dirs):\n"
        "        return True\n"
        "    for a in [p] + list(p.parents):\n"
        "        if a.name in ('site-packages', 'dist-packages') and any((v / 'pyvenv.cfg').is_file() for v in a.parents):\n"
        "            return True\n"
        "    return False\n\n"
        "for mod_name, mod in list(sys.modules.items()):\n"
        "    if mod is None:\n"
        "        continue\n"
        "    try:\n"
        "        f = getattr(mod, '__file__', None)\n"
        "        spec = getattr(mod, '__spec__', None)\n"
        "        origin = getattr(spec, 'origin', None) if spec else None\n"
        "        cand = f or origin\n"
        "        if cand and cand not in ('built-in', 'frozen'):\n"
        "            cp = pathlib.Path(cand).resolve()\n"
        "            if cp.is_absolute():\n"
        "                is_venv = _is_allowed_dep(cp)\n"
        "                if not is_venv:\n"
        "                    for ex in excluded_roots:\n"
        "                        if (cp == ex or ex in cp.parents) and not (cp == cwd_root or cwd_root in cp.parents):\n"
        "                            sys.modules.pop(mod_name, None)\n"
        "                            break\n"
        "        if mod_name in sys.modules and hasattr(mod, '__path__'):\n"
        "            for loc in (getattr(mod, '__path__', None) or []):\n"
        "                try:\n"
        "                    lp = pathlib.Path(loc).resolve()\n"
        "                    if lp.is_absolute():\n"
        "                        is_venv = _is_allowed_dep(lp)\n"
        "                        if not is_venv:\n"
        "                            for ex in excluded_roots:\n"
        "                                if (lp == ex or ex in lp.parents) and not (lp == cwd_root or cwd_root in lp.parents):\n"
        "                                    sys.modules.pop(mod_name, None)\n"
        "                                    break\n"
        "                except Exception:\n"
        "                    pass\n"
        "                if mod_name not in sys.modules:\n"
        "                    break\n"
        "    except Exception:\n"
        "        pass\n\n"
        "filtered = []\n"
        "for p in sys.path:\n"
        "    if not p:\n"
        "        continue\n"
        "    try:\n"
        "        rp = pathlib.Path(p).resolve()\n"
        "        is_venv_dep = _is_allowed_dep(rp)\n"
        "        is_excluded = any(rp == ex or ex in rp.parents for ex in excluded_roots)\n"
        "        if is_excluded and not (rp == cwd_root or cwd_root in rp.parents) and not is_venv_dep:\n"
        "            continue\n"
        "    except Exception:\n"
        "        pass\n"
        "    filtered.append(p)\n"
        "sys.path = [str(cwd_root)] + [p for p in filtered if p != str(cwd_root)]\n\n"
        "class _IsolatingFinder:\n"
        "    def __init__(self, original_finder):\n"
        "        self._orig = original_finder\n\n"
        "    def find_spec(self, fullname, path=None, target=None):\n"
        "        if not hasattr(self._orig, 'find_spec'):\n"
        "            return None\n"
        "        spec = self._orig.find_spec(fullname, path, target)\n"
        "        if spec is None:\n"
        "            return None\n"
        "        if spec.origin and spec.origin not in ('built-in', 'frozen'):\n"
        "            try:\n"
        "                op = pathlib.Path(spec.origin).resolve()\n"
        "                if op.is_absolute():\n"
        "                    is_venv = _is_allowed_dep(op)\n"
        "                    if not is_venv:\n"
        "                        for ex in excluded_roots:\n"
        "                            if (op == ex or ex in op.parents):\n"
        "                                if not (op == cwd_root or cwd_root in op.parents):\n"
        "                                    return None\n"
        "            except Exception:\n"
        "                pass\n"
        "        if getattr(spec, 'submodule_search_locations', None):\n"
        "            valid_locs = []\n"
        "            for loc in spec.submodule_search_locations:\n"
        "                try:\n"
        "                    lp = pathlib.Path(loc).resolve()\n"
        "                    if lp.is_absolute():\n"
        "                        is_venv = _is_allowed_dep(lp)\n"
        "                        if not is_venv:\n"
        "                            blocked = False\n"
        "                            for ex in excluded_roots:\n"
        "                                if (lp == ex or ex in lp.parents):\n"
        "                                    if not (lp == cwd_root or cwd_root in lp.parents):\n"
        "                                        blocked = True\n"
        "                                        break\n"
        "                            if blocked:\n"
        "                                continue\n"
        "                except Exception:\n"
        "                    pass\n"
        "                valid_locs.append(loc)\n"
        "            if not valid_locs and spec.submodule_search_locations:\n"
        "                return None\n"
        "            spec.submodule_search_locations = valid_locs\n"
        "        return spec\n\n"
        "    def find_module(self, fullname, path=None):\n"
        "        if not hasattr(self._orig, 'find_module'):\n"
        "            return None\n"
        "        loader = self._orig.find_module(fullname, path)\n"
        "        if loader is None:\n"
        "            return None\n"
        "        if hasattr(loader, 'get_filename'):\n"
        "            try:\n"
        "                fn = loader.get_filename(fullname)\n"
        "                if fn:\n"
        "                    op = pathlib.Path(fn).resolve()\n"
        "                    if op.is_absolute():\n"
        "                        is_venv = any(seg.lower() in ('site-packages', 'dist-packages') for seg in op.parts)\n"
        "                        if not is_venv:\n"
        "                            for ex in excluded_roots:\n"
        "                                if (op == ex or ex in op.parents):\n"
        "                                    if not (op == cwd_root or cwd_root in op.parents):\n"
        "                                        return None\n"
        "            except Exception:\n"
        "                pass\n"
        "        return loader\n\n"
        "    def invalidate_caches(self):\n"
        "        if hasattr(self._orig, 'invalidate_caches'):\n"
        "            self._orig.invalidate_caches()\n\n"
        "    def __getattr__(self, name):\n"
        "        return getattr(self._orig, name)\n\n"
        "sys.meta_path = [_IsolatingFinder(f) for f in sys.meta_path if not isinstance(f, _IsolatingFinder)]\n\n"
    ) + _render_unittest_suite_runner(test_target_repr, patterns_repr, pattern_desc_repr)


def _build_python_multi_pattern_script(cwd: Path, py_test_target: str, patterns: List[str]) -> str:
    """Generate simple multi-pattern discovery script for local non-worktree test execution."""
    patterns_repr = repr(patterns)
    target_repr = repr(py_test_target)
    pattern_desc_repr = repr(", ".join(patterns))
    return "import sys\n" + _render_unittest_suite_runner(target_repr, patterns_repr, pattern_desc_repr)


IGNORED_SOURCE_DEPENDENCY_DIR_NAMES = {
    "node_modules", ".venv", "venv", "env", ".git", ".pytest_cache",
    "__pycache__", "build", "dist", ".next", ".turbo", ".tox",
    ".cache", ".mypy_cache", ".ruff_cache"
}
SOURCE_DEPENDENCY_EXTENSIONS = (
    ".py", ".ts", ".js", ".tsx", ".jsx", ".json", ".env",
    ".mjs", ".cjs", ".mts", ".cts", ".pyi"
)


def _check_no_uncommitted_source_dependencies(cwd: Path, exec_env: dict, in_worktree: bool = False, stage_name: str = "validation"):
    """
    Ensure no uncommitted or untracked source dependencies exist that could allow tests to pass
    falsely on uncommitted local files instead of the committed candidate tree.
    Uses NUL-terminated byte parsing (-z) to accurately handle spaces, special characters, and non-ASCII paths.
    """
    # 1. Untracked files
    ret, untracked_bytes, err_untracked = run_subprocess_tree_safe_bytes(
        ["git", "ls-files", "-z", "--others", "--exclude-standard"],
        cwd=cwd, env=exec_env
    )
    if ret != 0:
        err_msg = os.fsdecode(err_untracked).strip() if err_untracked else "Unknown git ls-files error"
        print(f"\n❌ [Triad Gate Error] Failed to enumerate untracked files: {err_msg}", file=sys.stderr)
        sys.exit(1)

    untracked_entries = [os.fsdecode(e) for e in untracked_bytes.split(b"\0") if e]
    untracked_list = [f for f in untracked_entries if not (f == ".git" or f.startswith(".git/"))]

    if untracked_list:
        if not in_worktree:
            print("\n❌ [Triad Gate BLOCKED] Untracked files present in working directory outside isolation:\n" + "\n".join(untracked_list), file=sys.stderr)
            print("Direct gate validation cannot certify the staged index when untracked files exist (tests could pass via uncommitted dependencies).", file=sys.stderr)
            print("Run with 'triad gate --worktree' for isolated ephemeral verification, or stage/ignore the untracked files.", file=sys.stderr)
            sys.exit(1)
        else:
            # In isolated worktree: block if untracked source files or dependencies were created
            untracked_sources = []
            for f in untracked_list:
                p_parts = Path(f).parts
                if any(part in IGNORED_SOURCE_DEPENDENCY_DIR_NAMES for part in p_parts[:-1]):
                    continue
                if f.endswith(SOURCE_DEPENDENCY_EXTENSIONS):
                    untracked_sources.append(f)
            if untracked_sources:
                print(f"\n❌ [Triad Gate BLOCKED] Untracked source files present in isolated worktree ({stage_name}):\n" + "\n".join(f"  - {f}" for f in untracked_sources[:10]), file=sys.stderr)
                print("Gate validation cannot certify the candidate tree when untracked source dependencies exist.", file=sys.stderr)
                sys.exit(1)

    # 2. Ignored files
    ret_ig, ignored_bytes, err_ignored = run_subprocess_tree_safe_bytes(
        ["git", "ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
        cwd=cwd, env=exec_env
    )
    if ret_ig != 0:
        err_msg = os.fsdecode(err_ignored).strip() if err_ignored else "Unknown git ls-files error"
        print(f"\n❌ [Triad Gate Error] Failed to enumerate ignored files: {err_msg}", file=sys.stderr)
        sys.exit(1)

    ignored_entries = [os.fsdecode(e) for e in ignored_bytes.split(b"\0") if e]
    ignored_list = [f for f in ignored_entries if not (f == ".git" or f.startswith(".git/"))]

    if ignored_list:
        potential_deps = []
        for f in ignored_list:
            p_parts = Path(f).parts
            if any(part in IGNORED_SOURCE_DEPENDENCY_DIR_NAMES for part in p_parts[:-1]):
                continue
            if f.endswith(SOURCE_DEPENDENCY_EXTENSIONS):
                potential_deps.append(f)
        if potential_deps:
            env_desc = "isolated worktree" if in_worktree else "working directory outside isolation"
            print(f"\n❌ [Triad Gate BLOCKED] Ignored uncommitted source files present in {env_desc} ({stage_name}):\n" + "\n".join(f"  - {f}" for f in potential_deps[:10]), file=sys.stderr)
            print("Gate validation cannot certify the candidate tree when ignored source files exist (tests could pass via uncommitted dependencies).", file=sys.stderr)
            sys.exit(1)


def _clean_worktree_retry_artifacts(cwd: Path, candidate_tree: str, exec_env: dict) -> bool:
    """Reset tracked files and clean untracked/ignored validator side-effects between retries."""
    ret1, _, _ = run_subprocess_tree_safe(["git", "read-tree", "-u", "--reset", candidate_tree], cwd=cwd, env=exec_env)
    ret2, _, _ = run_subprocess_tree_safe(["git", "clean", "-fdx", "-e", "node_modules", "-e", "node_modules/**", "-e", ".venv", "-e", "venv"], cwd=cwd, env=exec_env)
    return ret1 == 0 and ret2 == 0


def _verify_checkout_representation(
    cwd: Path,
    candidate_tree: str,
    exec_env: Optional[Dict[str, str]] = None
) -> List[str]:
    """
    Certifies that every tracked file in candidate_tree matches its expected checkout representation.
    - Uses NUL-delimited get_tree_entries() to handle non-ASCII, spaces, tabs, and special characters.
    - Branches on Git mode:
      * Mode 120000 (symlink): verifies is_symlink() and compares os.readlink() target against the blob.
      * Mode 100644 / 100755 (regular file): verifies is_file() and not is_symlink(), compares file bytes
        against 'git cat-file --filters <candidate_tree>:<rel_path>' (accounting for smudge/clean filters),
        and verifies executable permissions / Git index mode parity across POSIX and Windows.
    - Fails closed: raises RuntimeError or reports mismatch on any inspection failure or cat-file error.
    Returns list of mismatch description strings (empty if 100% certified).
    """
    try:
        entries = get_tree_entries(candidate_tree, cwd, env=exec_env)
    except Exception as e:
        return [f"! Failed to enumerate tree {candidate_tree}: {e}"]

    # Query index stage modes to verify mode changes when core.fileMode=false
    stage_modes: Dict[str, str] = {}
    ret_st, out_st, _ = run_subprocess_tree_safe_bytes(["git", "ls-files", "-z", "--stage"], cwd=cwd, env=exec_env)
    if ret_st == 0 and out_st:
        for entry in out_st.split(b"\x00"):
            if not entry:
                continue
            try:
                meta, path_b = entry.split(b"\t", 1)
                st_mode_str = meta.split(b" ")[0].decode("ascii", errors="replace")
                stage_modes[os.fsdecode(path_b)] = st_mode_str
            except Exception:
                pass

    mismatches = []
    for rel_path, (mode, obj_type, sha) in entries.items():
        file_path = cwd / rel_path

        if mode == "160000" or obj_type == "commit":
            # Submodule / gitlink certification
            if not file_path.is_dir():
                mismatches.append(f"M\t{rel_path} (submodule directory missing)")
                continue
            ret_sub, sub_head, err_sub = run_subprocess_tree_safe(["git", "-C", str(file_path), "rev-parse", "HEAD"], cwd=cwd, env=exec_env)
            if ret_sub != 0 or not sub_head.strip():
                mismatches.append(f"M\t{rel_path} (submodule rev-parse failed: {err_sub.strip()})")
                continue
            if sub_head.strip() != sha.strip():
                mismatches.append(f"M\t{rel_path} (submodule commit mismatch: {sub_head.strip()} != {sha.strip()})")
                continue
            ret_stat, out_stat, err_stat = run_subprocess_tree_safe(["git", "-C", str(file_path), "status", "--porcelain"], cwd=cwd, env=exec_env)
            if ret_stat != 0:
                mismatches.append(f"M\t{rel_path} (submodule status inspection failed: {err_stat.strip()})")
                continue
            if out_stat.strip():
                mismatches.append(f"M\t{rel_path} (submodule working tree has uncommitted modifications)")
            continue

        if obj_type != "blob":
            continue

        if mode == "120000":
            # Symlink certification
            if not file_path.is_symlink():
                mismatches.append(f"M\t{rel_path} (expected symlink)")
                continue

            ret_cat, exp_target_bytes, err = run_subprocess_tree_safe_bytes(
                ["git", "cat-file", "blob", sha],
                cwd=cwd, env=exec_env
            )
            if ret_cat != 0:
                mismatches.append(f"! Failed to inspect symlink target for {rel_path}: {err}")
                continue

            try:
                actual_target = os.readlink(str(file_path))
                expected_target = os.fsdecode(exp_target_bytes)
                if actual_target != expected_target:
                    mismatches.append(f"M\t{rel_path} (symlink target mismatch: {actual_target} != {expected_target})")
            except Exception as e:
                mismatches.append(f"M\t{rel_path} (symlink read error: {e})")

        elif mode in ("100644", "100755"):
            # Regular file certification
            if file_path.is_symlink():
                mismatches.append(f"M\t{rel_path} (expected regular file, found symlink)")
                continue
            if not file_path.is_file():
                mismatches.append(f"D\t{rel_path}")
                continue

            # Verify executable mode parity
            if os.name != "nt":
                try:
                    st = os.lstat(str(file_path))
                    is_exec = (st.st_mode & 0o111) != 0
                    if mode == "100755" and not is_exec:
                        mismatches.append(f"M\t{rel_path} (mode mismatch: expected executable 100755, file is not executable)")
                    elif mode == "100644" and is_exec:
                        mismatches.append(f"M\t{rel_path} (mode mismatch: expected non-executable 100644, file is executable)")
                except Exception as e:
                    mismatches.append(f"M\t{rel_path} (mode inspection error: {e})")
            else:
                # Windows handling: check stage mode recorded in index when core.fileMode=false
                if rel_path in stage_modes and stage_modes[rel_path] != mode:
                    mismatches.append(f"M\t{rel_path} (mode mismatch: index has {stage_modes[rel_path]}, candidate tree has {mode})")

            ret_cat, exp_bytes, err = run_subprocess_tree_safe_bytes(
                ["git", "cat-file", "--filters", f"{candidate_tree}:{rel_path}"],
                cwd=cwd, env=exec_env
            )
            if ret_cat != 0:
                mismatches.append(f"! Failed to get expected checkout bytes for {rel_path}: {err}")
                continue

            try:
                cur_bytes = file_path.read_bytes()
                if not _content_matches(cur_bytes, exp_bytes):
                    mismatches.append(f"M\t{rel_path}")
            except Exception as e:
                mismatches.append(f"M\t{rel_path} (read error: {e})")

    return mismatches


def _handle_validation_failure(
    *,
    stage_label: str,
    exhausted_label: str,
    diag_output: str,
    cwd: Path,
    exec_env: Dict[str, str],
    args,
    in_worktree: bool,
    candidate_tree: str,
    attempt: int,
    max_retries: int,
) -> Tuple[int, str]:
    """
    Shared self-healing path for a failed validation stage (tsc / npm test / python tests).

    Behaviour:
      * In an isolated worktree, validator side-effects are rolled back to ``candidate_tree``
        first so a retry starts from a clean baseline.
      * If the retry budget is exhausted the gate fails closed (exit 1).
      * Otherwise the Advisory Council is asked for a surgical unified diff.
          - Direct (non-worktree) execution never mutates the user's files: the proposed
            patch is persisted to ``.triad_proposed_fix.patch`` and the gate exits 1.
          - Worktree execution applies the patch, stages it, records it in
            ``args._self_healed_patches`` and returns the new ``(attempt, candidate_tree)``
            so the caller can restart the validation sequence.
    """
    if in_worktree:
        if not _clean_worktree_retry_artifacts(cwd, candidate_tree, exec_env):
            print("\n❌ [Triad Gate Error] Failed to restore worktree baseline before retry.", file=sys.stderr)
            sys.exit(1)

    print(f"\n❌ [Triad Gate: {stage_label}:\n{diag_output}")

    if attempt >= max_retries:
        print(f"\n❌ [Triad Gate FAILED] {exhausted_label}")
        sys.exit(1)

    attempt += 1
    print(f"\n[Self-Healing Safety Net: Retry {attempt}/{max_retries}] Consulting Advisory Council in debug mode for surgical fix...")
    advisor_fix = query_gate_fix(diag_output, args)
    print(f"[Advisory Council Proposed Fix]:\n{advisor_fix}\n")

    if not in_worktree:
        patch_file = cwd / ".triad_proposed_fix.patch"
        try:
            patch_file.write_text(advisor_fix, encoding="utf-8")
            print(f"\n[Triad Direct Execution Notice] Self-healing fix proposed by Advisory Council persisted to:\n  {patch_file}")
        except Exception:
            pass
        print("Direct execution preserves working directory files without uncoordinated in-place mutation.")
        print("To review or apply the fix: git apply .triad_proposed_fix.patch")
        print("Or run with 'triad gate --worktree --apply-verified' for isolated verification and atomic application.")
        sys.exit(1)

    if not apply_patch_text(advisor_fix, cwd=cwd, env=exec_env, allow_3way=True):
        print("! Could not automatically apply patch via git apply. Aborting gate.")
        sys.exit(1)

    try:
        _stage_candidate_worktree_changes(cwd=cwd, exec_env=exec_env, head_tree=candidate_tree)
    except Exception as stage_err:
        print(f"\n❌ [Triad Gate Error] Failed to stage healed changes: {stage_err}", file=sys.stderr)
        sys.exit(1)
    if hasattr(args, "_self_healed_patches"):
        args._self_healed_patches.append(advisor_fix)
    ret_tr, new_tree, _ = run_subprocess_tree_safe(["git", "write-tree"], cwd=cwd, env=exec_env)
    if ret_tr == 0 and new_tree.strip():
        candidate_tree = new_tree.strip()
    print("✓ Applied advisory patch to worktree. Restarting validation sequence...\n")
    return attempt, candidate_tree


def _affects_typescript(changed_files: List[str]) -> bool:
    ts_exts = frozenset({".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"})
    ts_configs = frozenset({"package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"})
    for f in changed_files:
        p = f.replace("\\", "/").lower()
        base = os.path.basename(p)
        if base in ts_configs or (base.startswith("tsconfig") and base.endswith(".json")):
            return True
        if base.endswith(".d.ts"):
            return True
        _, ext = os.path.splitext(base)
        if ext in ts_exts:
            return True
    return False


def _affects_code(changed_files: List[str]) -> bool:
    for f in changed_files:
        if not is_doc_or_asset_file(f):
            return True
    return False


CORE_MODULE_NAMES = {
    "triad_engine",
    "worktree",
    "paths",
    "server",
    "intent_engine",
    "competition",
    "circuit",
    "advisor_manager",
}


BUILD_MANIFEST_NAMES = {
    "pyproject.toml", "uv.lock", "setup.py", "setup.cfg", "tox.ini", "pytest.ini",
    "conftest.py", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "bun.lockb", "Pipfile", "Pipfile.lock",
}


SKIP_IMPORT_INDEX_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__",
    ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages", ".eggs",
}


_FILE_IMPORT_CACHE: Dict[str, Tuple[int, int, Set[str]]] = {}
_MAX_FILE_IMPORT_CACHE_ENTRIES = 5000


def _clear_import_index_caches() -> None:
    """Clear both the repository aggregate cache and file-level AST token cache."""
    _import_index.cache_clear()
    _FILE_IMPORT_CACHE.clear()


@lru_cache(maxsize=8)
def _import_index(cwd_resolved: Path) -> Optional[Dict[str, Set[str]]]:
    """
    Build index mapping imported module name to set of importing file relative paths across repository.
    Scans repository via AST parsing with per-file mtime invalidation (conservative fallback on parse or read error).
    """
    imported_to_callers: Dict[str, Set[str]] = {}
    for root, dirs, files in os.walk(str(cwd_resolved)):
        rel_root = os.path.relpath(root, str(cwd_resolved)).replace("\\", "/")
        dirs[:] = [
            d for d in dirs
            if d not in SKIP_IMPORT_INDEX_DIRS
            and not (rel_root == "." and d in (".cursor", ".next", ".turbo"))
            and not ((rel_root == ".triad" or rel_root.startswith(".triad/")) and d == "worktrees")
            and not (Path(root) / d / "pyvenv.cfg").exists()
        ]
        for f in files:
            if not f.endswith(".py"):
                continue
            p = Path(root) / f
            try:
                rel = p.relative_to(cwd_resolved)
            except ValueError:
                rel = p
            rel_str = str(rel).replace("\\", "/")

            p_str = str(p)
            try:
                st = p.stat()
                mtime_ns = st.st_mtime_ns
                size = st.st_size
            except OSError:
                return None  # conservative fallback -> caller treats as "has importers"

            cached = _FILE_IMPORT_CACHE.get(p_str)
            if cached is not None and cached[0] == mtime_ns and cached[1] == size:
                file_tokens = cached[2]
            else:
                try:
                    content = p.read_text(encoding="utf-8", errors="ignore")
                    tree = ast.parse(content)
                    file_tokens = set()
                    for n in ast.walk(tree):
                        if isinstance(n, ast.Import):
                            for a in n.names:
                                for part in a.name.split("."):
                                    file_tokens.add(part)
                        elif isinstance(n, ast.ImportFrom):
                            if n.module:
                                for part in n.module.split("."):
                                    file_tokens.add(part)
                            for a in n.names:
                                file_tokens.add(a.name)
                        elif isinstance(n, ast.Call):
                            func_id = ""
                            if isinstance(n.func, ast.Name):
                                func_id = n.func.id
                            elif isinstance(n.func, ast.Attribute):
                                func_id = n.func.attr
                            if func_id in ("import_module", "__import__") and n.args:
                                for c in ast.walk(n.args[0]):
                                    if isinstance(c, ast.Constant) and isinstance(c.value, str):
                                        for part in re.findall(r"[A-Za-z_]\w*", c.value):
                                            file_tokens.add(part)
                        elif isinstance(n, ast.Constant) and isinstance(n.value, str) and 0 < len(n.value) < 200:
                            v = n.value.replace("\\", "/")
                            file_tokens.add(v)
                            file_tokens.add(v.rsplit("/", 1)[-1])
                            for match in re.findall(r"\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b", n.value):
                                for part in match.split("."):
                                    file_tokens.add(part)
                    if len(_FILE_IMPORT_CACHE) >= _MAX_FILE_IMPORT_CACHE_ENTRIES:
                        _FILE_IMPORT_CACHE.clear()
                    _FILE_IMPORT_CACHE[p_str] = (mtime_ns, size, file_tokens)
                except (SyntaxError, ValueError, RecursionError):
                    file_tokens = set()
                    for tok in set(re.findall(r"[A-Za-z_][A-Za-z0-9_.]*", content)):
                        for part in tok.split("."):
                            file_tokens.add(part)
                    if len(_FILE_IMPORT_CACHE) >= _MAX_FILE_IMPORT_CACHE_ENTRIES:
                        _FILE_IMPORT_CACHE.clear()
                    _FILE_IMPORT_CACHE[p_str] = (mtime_ns, size, file_tokens)
                except OSError:
                    return None

            for tok in file_tokens:
                imported_to_callers.setdefault(tok, set()).add(rel_str)

    return imported_to_callers


def _has_importers(name: str, cwd: Path) -> bool:
    """
    Check if any Python module other than the module itself and its dedicated unit test imports this module.
    """
    idx = _import_index(cwd.resolve())
    if idx is None:
        return True  # conservative fallback on unparseable/error repository
    callers = idx.get(name, set())
    own = {
        f"triad/{name}.py", f"{name}.py",
        f"triad/tests/test_{name}.py", f"tests/test_{name}.py",
    }
    for caller_rel in callers:
        norm_caller = caller_rel.replace("\\", "/")
        if norm_caller.startswith("./"):
            norm_caller = norm_caller[2:]
        if norm_caller not in own:
            return True

    # Check if entrypoints, manifests, or CI workflows reference this module name
    manifest_paths = [cwd / m for m in BUILD_MANIFEST_NAMES]
    wf_dir = cwd / ".github" / "workflows"
    if wf_dir.exists():
        manifest_paths.extend(wf_dir.glob("*.yml"))
        manifest_paths.extend(wf_dir.glob("*.yaml"))
    pat = re.compile(rf"\b{re.escape(name)}\b")
    for mp in manifest_paths:
        if mp.exists() and mp.is_file():
            try:
                txt = mp.read_text(encoding="utf-8", errors="ignore")
                if pat.search(txt):
                    return True
            except OSError:
                pass

    return False


def _resolve_targeted_test_pattern(changed_files: List[str], cwd: Path) -> str:
    """Resolve targeted test pattern from changed files, falling back to 'test_*.py' for core/imported files or ambiguity."""
    if not changed_files:
        return "test_*.py"
    matched_patterns = set()
    for f in changed_files:
        norm = f.replace("\\", "/")
        base = os.path.basename(norm)
        name, ext = os.path.splitext(base)

        # 1. Core infrastructure or build manifest files MUST trigger full test suite
        if name in CORE_MODULE_NAMES or base in BUILD_MANIFEST_NAMES or base.startswith("requirements"):
            return "test_*.py"

        # 2. Test file itself modified
        if base.startswith("test_") and ext == ".py":
            matched_patterns.add(base)
            continue

        # 3. Documentation or non-code assets
        if is_doc_or_asset_file(norm):
            if _has_importers(name, cwd) or _has_importers(base, cwd):
                return "test_*.py"
            # Pure documentation files can be safely skipped
            if ext.lower() in (".md", ".txt", ".rst"):
                continue
            # Any other non-pure-doc asset (e.g. .json, .yaml, .png, templates) triggers full suite
            return "test_*.py"

        # 4. Only Python source files can resolve to targeted Python tests
        if ext != ".py":
            return "test_*.py"

        # 5. If any other module or external test imports this module, partial testing is unsound
        if _has_importers(name, cwd):
            return "test_*.py"

        candidate_name = f"test_{name}.py"
        if (cwd / "triad" / "tests" / candidate_name).exists() or (cwd / "tests" / candidate_name).exists():
            matched_patterns.add(candidate_name)
        else:
            return "test_*.py"

    if matched_patterns:
        return ",".join(sorted(matched_patterns))
    return "test_*.py"


def _resolve_pytest_xdist_cmd(target: str, cwd: Optional[Path] = None, env: Optional[Dict[str, str]] = None) -> Optional[List[str]]:
    """Determine if pytest with xdist is available in current python environment or uv."""
    try:
        ret, _, _ = run_subprocess_tree_safe([sys.executable, "-c", "import pytest, xdist"], cwd=cwd, env=env, timeout=5)
        if ret == 0:
            return [sys.executable, "-m", "pytest", "-n", "auto", "--dist=loadfile", "-p", "no:cacheprovider", target]
    except Exception:
        pass
    uv_bin = shutil.which("uv")
    if uv_bin:
        try:
            ret, _, _ = run_subprocess_tree_safe([uv_bin, "run", "--no-sync", "python", "-c", "import pytest, xdist"], cwd=cwd, env=env, timeout=10)
            if ret == 0:
                return [uv_bin, "run", "--no-sync", "pytest", "-n", "auto", "--dist=loadfile", "-p", "no:cacheprovider", target]
        except Exception:
            pass
    return None


def _run_gate(args, env: Optional[Dict[str, str]] = None, in_worktree: bool = False, review_base: Optional[str] = None, cwd: Optional[Path] = None):
    exec_env = dict(os.environ if env is None else env)
    gate_pycache_dir: Optional[Path] = None
    if "PYTHONDONTWRITEBYTECODE" not in exec_env:
        try:
            gate_pycache_dir = Path(tempfile.mkdtemp(prefix="triad_gate_pycache_"))
        except Exception:
            gate_pycache_dir = None

    try:
        return _run_gate_impl(args, env=env, in_worktree=in_worktree, review_base=review_base, cwd=cwd, gate_pycache_dir=gate_pycache_dir)
    finally:
        if gate_pycache_dir and gate_pycache_dir.exists():
            shutil.rmtree(str(gate_pycache_dir), ignore_errors=True)


def _run_gate_impl(args, env: Optional[Dict[str, str]] = None, in_worktree: bool = False, review_base: Optional[str] = None, cwd: Optional[Path] = None, gate_pycache_dir: Optional[Path] = None):
    _import_index.cache_clear()
    cwd = (cwd or Path.cwd()).resolve()
    exec_env = dict(os.environ if env is None else env)
    exec_env["TRIAD_GATE_ACTIVE"] = "1"
    in_worktree = getattr(args, "_in_worktree", False) or in_worktree
    review_base = getattr(args, "_review_base", None) or review_base

    # Reject combination of --apply-verified with targeted test execution up front
    _check_apply_verified_safety(args, exec_env)

    ret_head, initial_head_commit, _ = run_subprocess_tree_safe(["git", "rev-parse", "--verify", "HEAD"], cwd=cwd, env=exec_env)
    initial_head_commit = initial_head_commit.strip() if ret_head == 0 else "UNBORN"

    # Resolve target baseline tree for change detection and diff
    try:
        if review_base:
            ret_base, base_tree, _ = run_subprocess_tree_safe(["git", "rev-parse", "--verify", f"{review_base}^{{tree}}"], cwd=cwd, env=exec_env)
            if ret_base == 0 and base_tree.strip():
                target_base = base_tree.strip()
            else:
                ret_base2, base_tree2, _ = run_subprocess_tree_safe(["git", "rev-parse", "--verify", review_base], cwd=cwd, env=exec_env)
                target_base = base_tree2.strip() if ret_base2 == 0 and base_tree2.strip() else review_base
        else:
            ret_head_tree, head_tree, _ = run_subprocess_tree_safe(["git", "rev-parse", "--verify", "HEAD^{tree}"], cwd=cwd, env=exec_env)
            target_base = head_tree.strip() if ret_head_tree == 0 and head_tree.strip() else get_empty_tree_oid(cwd)
    except Exception as e:
        print(f"\n❌ [Triad Gate BLOCKED] Failed to resolve baseline tree: {e}", file=sys.stderr)
        sys.exit(1)

    def _verify_final_stability(cand_tree: Optional[str] = None, init_wt: Optional[str] = None, init_fp: Optional[dict] = None):
        c_tree = cand_tree if cand_tree is not None else candidate_tree
        i_wt = init_wt if init_wt is not None else initial_wt_tree
        i_fp = init_fp if init_fp is not None else initial_fingerprint
        ret_head, current_head_commit, _ = run_subprocess_tree_safe(["git", "rev-parse", "--verify", "HEAD"], cwd=cwd, env=exec_env)
        current_head_commit = current_head_commit.strip() if ret_head == 0 else "UNBORN"
        if current_head_commit != initial_head_commit:
            print(f"\n❌ [Triad Gate BLOCKED] Git HEAD was modified during validation (expected {initial_head_commit[:10]}, got {current_head_commit[:10]}).", file=sys.stderr)
            sys.exit(1)
        post_wt = snapshot_worktree_tree(cwd, head_tree=c_tree, env=exec_env)
        if post_wt != i_wt:
            ret, diff_summary, _ = run_subprocess_tree_safe(["git", "diff", "--no-color", "--name-status", i_wt, post_wt], cwd=cwd, env=exec_env)
            print(f"\n❌ [Triad Gate BLOCKED] Working tree was modified during evaluation:\n{diff_summary}", file=sys.stderr)
            sys.exit(1)
        post_fingerprint = compute_working_tree_fingerprint(cwd, env=exec_env)
        fp_match, mutated = fingerprints_match(i_fp, post_fingerprint)
        if not fp_match:
            diff_msg = "\n".join(mutated)
            print(f"\n❌ [Triad Gate BLOCKED] Working tree files mutated on disk during evaluation:\n{diff_msg}", file=sys.stderr)
            sys.exit(1)
        ret, post_idx, err = run_subprocess_tree_safe(["git", "write-tree"], cwd=cwd, env=exec_env)
        if ret != 0 or post_idx.strip() != c_tree:
            print("\n❌ [Triad Gate BLOCKED] Git index was modified during evaluation.", file=sys.stderr)
            sys.exit(1)
        _check_no_uncommitted_source_dependencies(cwd, exec_env, in_worktree=in_worktree, stage_name="post-validation")

    print(f"[Triad Gate] Running pre-commit verification in {cwd}...\n")
    max_retries = max(0, getattr(args, "max_retries", 1))

    tsconfig = cwd / "tsconfig.json"
    package_json = cwd / "package.json"
    test_timeout = int(os.environ.get("TRIAD_TEST_TIMEOUT", getattr(args, "test_timeout", 300)))

    attempt = 0
    candidate_tree = None
    while attempt <= max_retries:
        _import_index.cache_clear()
        if attempt > 0 and gate_pycache_dir and gate_pycache_dir.exists():
            shutil.rmtree(str(gate_pycache_dir), ignore_errors=True)
            gate_pycache_dir.mkdir(parents=True, exist_ok=True)
        # Capture candidate tree snapshot before running validation checks
        ret, candidate_tree, err = run_subprocess_tree_safe(["git", "write-tree"], cwd=cwd, env=exec_env)
        if ret != 0 or not candidate_tree.strip():
            print(f"\n❌ [Triad Gate Error] Failed to capture candidate tree snapshot: {err}", file=sys.stderr)
            sys.exit(1)
        candidate_tree = candidate_tree.strip()

        # Capture content-based baseline working-tree snapshot and filesystem fingerprint
        try:
            initial_wt_tree = snapshot_worktree_tree(cwd, head_tree=candidate_tree, env=exec_env)
            initial_fingerprint = compute_working_tree_fingerprint(cwd, env=exec_env)
        except Exception as e:
            print(f"\n❌ [Triad Gate Error] Failed to establish working tree baseline: {e}", file=sys.stderr)
            sys.exit(1)

        # Check for uncommitted source dependencies first
        _check_no_uncommitted_source_dependencies(cwd, exec_env, in_worktree=in_worktree, stage_name="pre-validation")

        # Verify working tree parity with candidate index
        if in_worktree:
            if initial_wt_tree != candidate_tree:
                print("\n❌ [Triad Gate Error] Isolated working tree differs from candidate index.", file=sys.stderr)
                sys.exit(1)
            # Certify checkout-byte representation in isolated worktree
            wt_mismatches = _verify_checkout_representation(cwd, candidate_tree, exec_env=exec_env)
            if wt_mismatches:
                diff_msg = ":\n" + "\n".join(wt_mismatches)
                print(f"\n❌ [Triad Gate Error] Isolated worktree bytes do not match expected checkout representation{diff_msg}", file=sys.stderr)
                sys.exit(1)
        else:
            # Direct gate execution: ensure actual working-tree bytes match the candidate index
            if initial_wt_tree != candidate_tree:
                _, unstaged_diff, _ = run_subprocess_tree_safe(["git", "diff", "--no-color", "--name-status", candidate_tree, initial_wt_tree], cwd=cwd, env=exec_env)
                diff_msg = ":\n" + unstaged_diff.strip() if unstaged_diff.strip() else ""
                print(f"\n❌ [Triad Gate BLOCKED] Working tree differs from candidate index{diff_msg}", file=sys.stderr)
                print("Direct gate validation requires tracked files to match the staged index to ensure what is tested is what is committed.", file=sys.stderr)
                print("Either stage all changes, discard unstaged edits, or use 'triad gate --worktree' for isolated index verification.", file=sys.stderr)
                sys.exit(1)

            run_subprocess_tree_safe(["git", "update-index", "-q", "--refresh"], cwd=cwd, env=exec_env)
            ret_df, diff_files, _ = run_subprocess_tree_safe(["git", "diff-files", "--no-color", "--name-status"], cwd=cwd, env=exec_env)
            if diff_files.strip():
                print(f"\n❌ [Triad Gate BLOCKED] Tracked files have unstaged modifications:\n{diff_files.strip()}", file=sys.stderr)
                print("Direct gate validation requires tracked files to match the staged index to ensure what is tested is what is committed.", file=sys.stderr)
                print("Either stage all changes, discard unstaged edits, or use 'triad gate --worktree' for isolated index verification.", file=sys.stderr)
                sys.exit(1)

            # Certify filesystem bytes against expected checkout representation for tracked files (detecting clean-filter bypasses)
            mismatched_files = _verify_checkout_representation(cwd, candidate_tree, exec_env=exec_env)
            if mismatched_files:
                diff_msg = ":\n" + "\n".join(mismatched_files)
                print(f"\n❌ [Triad Gate BLOCKED] Tracked files do not match expected checkout representation{diff_msg}", file=sys.stderr)
                print("Direct gate validation requires tracked files to match the staged index to ensure what is tested is what is committed.", file=sys.stderr)
                print("Either stage all changes, discard unstaged edits, or use 'triad gate --worktree' for isolated index verification.", file=sys.stderr)
                sys.exit(1)

        # Query which files changed between target_base and candidate_tree
        ret_df, changed_files_raw, _ = run_subprocess_tree_safe(
            ["git", "diff", "--no-color", "--no-ext-diff", "--no-renames", "--name-only", "-z", target_base, candidate_tree, "--"],
            cwd=cwd, env=exec_env
        )
        changed_files = [f.strip() for f in changed_files_raw.split("\0") if f.strip()]
        if changed_files:
            affects_code = _affects_code(changed_files)
            affects_ts = _affects_typescript(changed_files)
        else:
            affects_code = True
            affects_ts = True

        # Step 1: TypeScript Check
        if not affects_code:
            print("[Step 1/3] Only documentation / non-code assets changed. Skipping TypeScript check.")
        elif not affects_ts:
            print("[Step 1/3] No TypeScript or JavaScript files changed. Skipping tsc check.")
        elif tsconfig.exists():
            nm_dir = cwd / "node_modules"
            if not nm_dir.exists() and package_json.exists():
                print(f"\n❌ [Triad Gate Error] tsconfig.json found but node_modules does not exist in {cwd}.", file=sys.stderr)
                print("Cannot certify TypeScript compilation without installed dependencies.", file=sys.stderr)
                print("Run 'npm install' or ensure node_modules is present before running pre-commit verification.", file=sys.stderr)
                sys.exit(1)

            print("[Step 1/3] Verifying TypeScript type safety (npx tsc --noEmit)...")
            ret, out, err = run_subprocess_tree_safe([NPX_CMD, "tsc", "--noEmit"], cwd=cwd, timeout=test_timeout, env=exec_env)
            if ret != 0:
                attempt, candidate_tree = _handle_validation_failure(
                    stage_label="Step 1 FAILED] TypeScript errors detected",
                    exhausted_label="TypeScript errors persist after retry budget exhausted.",
                    diag_output=f"STDOUT:\n{out}\nSTDERR:\n{err}".strip(),
                    cwd=cwd, exec_env=exec_env, args=args, in_worktree=in_worktree,
                    candidate_tree=candidate_tree, attempt=attempt, max_retries=max_retries,
                )
                continue
            print("✓ TypeScript: 0 errors.")
        else:
            print("[Step 1/3] No tsconfig.json found. Skipping tsc check.")

        # Step 2: Test Suites (Supports polyglot projects: Node/Jest/Vitest AND Python/Unittest/Pytest)
        ran_any_tests = False
        step2_failed = False

        if not affects_code:
            print("[Step 2/3] Only documentation / non-code assets changed. Skipping test suite.")
        else:
            if package_json.exists():
                try:
                    with open(package_json, "r", encoding="utf-8") as f:
                        pkg_data = json.load(f)
                    scripts = pkg_data.get("scripts", {})
                    if "test" in scripts:
                        ran_any_tests = True
                        print("[Step 2/3] Running local test suite (npm test)...")
                        test_cmd = [NPM_CMD, "test", "--", "--run"]
                        ret, out, err = run_subprocess_tree_safe(test_cmd, cwd=cwd, timeout=test_timeout, env=exec_env)

                        if ret != 0:
                            step2_failed = True
                            attempt, candidate_tree = _handle_validation_failure(
                                stage_label="Step 2 FAILED] Node test suite failed",
                                exhausted_label="Test suite still failing after retry budget exhausted.",
                                diag_output=f"STDOUT:\n{out}\nSTDERR:\n{err}".strip(),
                                cwd=cwd, exec_env=exec_env, args=args, in_worktree=in_worktree,
                                candidate_tree=candidate_tree, attempt=attempt, max_retries=max_retries,
                            )
                            continue
                        print("✓ Node/npm tests passed successfully.")
                except SystemExit:
                    raise
                except Exception as e:
                    print(f"\n❌ [Triad Gate: Step 2 FAILED] Error executing Node test runner: {e}")
                    sys.exit(1)

            # Python test discovery: run all configured suites (supports targeted test patterns)
            py_test_targets = []
            if (cwd / "triad" / "tests").exists():
                py_test_targets.append("triad/tests")
            if (cwd / "tests").exists():
                py_test_targets.append("tests")

            raw_target_arg = getattr(args, "target", "") or exec_env.get("TRIAD_TEST_TARGET", "")
            norm_target = _normalize_target(raw_target_arg)
            explicit_target = norm_target != "test_*.py"
            target_source = ""
            if attempt > 0:
                # Post-heal retry verification: always execute full test suite to guarantee zero side regressions
                test_pattern = "test_*.py"
            elif _is_ci(exec_env):
                if explicit_target:
                    print("[Triad Gate Notice] CI environment detected; running full test suite 'test_*.py'.")
                test_pattern = "test_*.py"
            elif explicit_target:
                test_pattern = norm_target
            elif getattr(args, "targeted", False) or exec_env.get("TRIAD_TARGETED_TESTS") == "1":
                target_source = "--targeted" if getattr(args, "targeted", False) else "TRIAD_TARGETED_TESTS"
                test_pattern = _resolve_targeted_test_pattern(changed_files, cwd)
            else:
                test_pattern = "test_*.py"

            setattr(args, "_active_test_pattern", test_pattern)
            all_py_test_targets = list(py_test_targets)
            is_targeted = test_pattern != "test_*.py"
            explicit_target = explicit_target and is_targeted
            active_patterns = [p.strip() for p in test_pattern.split(",") if p.strip()]
            if is_targeted:
                banner_source = "explicit --target" if explicit_target else f"auto-resolved via {target_source}"
                print(f"[Step 2/3] [TARGETED GATE] Running test pattern(s) '{test_pattern}' ({banner_source})...")

                # Filter target directories to only those containing matching test files
                active_targets = []
                for target_dir in py_test_targets:
                    td_path = cwd / target_dir
                    if any(any(td_path.rglob(pat)) for pat in active_patterns):
                        active_targets.append(target_dir)

                if not active_targets and py_test_targets:
                    if explicit_target:
                        print(
                            f"\n[Triad Gate: Step 2 FAILED] Targeted test pattern '{test_pattern}' matched 0 test files in {py_test_targets}.",
                            file=sys.stderr,
                        )
                        sys.exit(5)
                    else:
                        print(f"[Step 2/3] Targeted test pattern '{test_pattern}' matched 0 test files in {py_test_targets}; falling back to full test suite.")
                        test_pattern = "test_*.py"
                        setattr(args, "_active_test_pattern", test_pattern)
                        is_targeted = False
                        active_patterns = [test_pattern]
                        active_targets = py_test_targets
                py_test_targets = active_targets

            target_idx = 0
            while target_idx < len(py_test_targets):
                py_test_target = py_test_targets[target_idx]
                target_idx += 1
                ran_any_tests = True
                pattern_desc = f", pattern: {test_pattern}" if is_targeted else ""
                print(f"[Step 2/3] Running Python unit test suite ({py_test_target}{pattern_desc})...")
                py_test_env = dict(exec_env if exec_env is not None else os.environ)
                if gate_pycache_dir and gate_pycache_dir.exists():
                    py_test_env["PYTHONPYCACHEPREFIX"] = str(gate_pycache_dir)
                    py_test_env.pop("PYTHONDONTWRITEBYTECODE", None)
                else:
                    py_test_env["PYTHONDONTWRITEBYTECODE"] = "1"
                py_test_env["TRIAD_GATE_ACTIVE"] = "1"
                if in_worktree:
                    py_test_env["TRIAD_ISOLATED_WORKTREE"] = "1"
                    orig_pp = py_test_env.get("PYTHONPATH", "")
                    sanitized_pp_parts = [str(cwd.resolve())]
                    originating_root_val = getattr(args, "_originating_root", None)
                    originating_root = Path(originating_root_val).resolve() if originating_root_val else None
                    if not originating_root:
                        try:
                            originating_root = get_repo_root(cwd, env=exec_env)
                        except Exception:
                            pass

                    parent_root = None
                    try:
                        ret_c, out_c, _ = run_subprocess_tree_safe(
                            ["git", "rev-parse", "--git-common-dir"],
                            cwd=cwd, env=exec_env
                        )
                        if ret_c == 0 and out_c.strip():
                            common_git = Path(out_c.strip())
                            if not common_git.is_absolute():
                                common_git = (cwd / common_git).resolve()
                            parent_root = common_git.parent.resolve()
                    except Exception:
                        pass
                    if not parent_root:
                        try:
                            parent_root = get_repo_root(cwd, env=exec_env)
                        except Exception:
                            pass

                    if not parent_root and not originating_root:
                        print("\n❌ [Triad Gate Error] Failed to establish parent repository exclusion boundary for Python import isolation.", file=sys.stderr)
                        sys.exit(1)

                    excluded_roots: List[Path] = []
                    for candidate_root in [parent_root, originating_root]:
                        if candidate_root and candidate_root not in excluded_roots and candidate_root != cwd.resolve():
                            excluded_roots.append(candidate_root)

                    if orig_pp:
                        for part in orig_pp.split(os.pathsep):
                            if not part:
                                continue
                            try:
                                resolved_part = Path(part).resolve()
                                is_venv_dep = any(seg.lower() in ("site-packages", "dist-packages") for seg in resolved_part.parts)
                                is_excluded = any(
                                    (resolved_part == ex or ex in resolved_part.parents)
                                    for ex in excluded_roots
                                )
                                if is_excluded and not is_venv_dep:
                                    if not (cwd.resolve() == resolved_part or cwd.resolve() in resolved_part.parents):
                                        continue
                                if str(resolved_part) not in sanitized_pp_parts:
                                    sanitized_pp_parts.append(str(resolved_part))
                            except Exception:
                                pass
                    py_test_env["PYTHONPATH"] = os.pathsep.join(sanitized_pp_parts)

                is_parallel_requested = bool(getattr(args, "parallel", False) or py_test_env.get("TRIAD_PARALLEL_TESTS") == "1")
                target_patterns = [pat for pat in active_patterns if any((cwd / py_test_target).rglob(pat))] if is_targeted else active_patterns
                if not target_patterns:
                    target_patterns = ["test_*.py"]
                if in_worktree:
                    if is_parallel_requested:
                        print("[Step 2/3] [Notice] --parallel is bypassed in isolated worktree mode (worktree runner manages process isolation).")
                    isolation_script = _build_python_isolation_script(cwd, py_test_target, excluded_roots, pattern=target_patterns)
                    test_cmd = [sys.executable, "-c", isolation_script]
                else:
                    if is_targeted:
                        if is_parallel_requested:
                            print("[Step 2/3] [Notice] --parallel is bypassed for targeted test pattern(s).")
                        if len(target_patterns) > 1:
                            multi_script = _build_python_multi_pattern_script(cwd, py_test_target, target_patterns)
                            test_cmd = [sys.executable, "-c", multi_script]
                        else:
                            test_cmd = [sys.executable, "-m", "unittest", "discover", "-s", py_test_target, "-p", target_patterns[0]]
                    elif is_parallel_requested:
                        xdist_cmd = _resolve_pytest_xdist_cmd(py_test_target, cwd=cwd, env=py_test_env)
                        if xdist_cmd:
                            print("[Step 2/3] [PARALLEL] Executing test suite via pytest-xdist across CPU cores...")
                            test_cmd = xdist_cmd
                        else:
                            print("[Step 2/3] [Notice] pytest-xdist not detected; executing sequentially via unittest.")
                            test_cmd = [sys.executable, "-m", "unittest", "discover", "-s", py_test_target, "-p", test_pattern]
                    else:
                        test_cmd = [sys.executable, "-m", "unittest", "discover", "-s", py_test_target, "-p", test_pattern]
                ret, out, err = run_subprocess_tree_safe(test_cmd, cwd=cwd, timeout=test_timeout, env=py_test_env)

                diag_output = f"STDOUT:\n{out}\nSTDERR:\n{err}".strip()
                is_empty_suite = ("Ran 0 tests" in diag_output) or ("collected 0 items" in diag_output) or (ret == 5)
                if is_empty_suite:
                    if explicit_target:
                        print(
                            f"\n[Triad Gate: Step 2 FAILED] Explicit test target '{test_pattern}' matched 0 test cases.\n{diag_output}",
                            file=sys.stderr,
                        )
                        sys.exit(5)
                    elif is_targeted:
                        print(f"[Step 2/3] Targeted test pattern '{test_pattern}' matched 0 test cases; falling back to full test suite.")
                        test_pattern = "test_*.py"
                        setattr(args, "_active_test_pattern", test_pattern)
                        is_targeted = False
                        active_patterns = [test_pattern]
                        py_test_targets = list(all_py_test_targets)
                        target_idx = 0
                        continue

                if ret != 0 or is_empty_suite:
                    step2_failed = True
                    reason = "discovering 0 tests" if is_empty_suite else "failures"
                    attempt, candidate_tree = _handle_validation_failure(
                        stage_label=f"Step 2 FAILED] Python test suite failed ({reason})",
                        exhausted_label="Python test suite still failing after retry budget exhausted.",
                        diag_output=diag_output,
                        cwd=cwd, exec_env=exec_env, args=args, in_worktree=in_worktree,
                        candidate_tree=candidate_tree, attempt=attempt, max_retries=max_retries,
                    )
                    break  # breaks out of targets loop to restart validation
                print(f"✓ Python tests ({py_test_target}) passed successfully.")

            if step2_failed:
                continue

            if not ran_any_tests:
                print("[Step 2/3] No test runner found (package.json / Python tests). Skipping.")
                setattr(args, "_active_test_pattern", None)

        # Check for uncommitted source dependencies created during validation
        _check_no_uncommitted_source_dependencies(cwd, exec_env, in_worktree=in_worktree, stage_name="post-validation")

        # Content-based mutation verification: detect any content, addition, deletion, or revert
        final_wt_tree = snapshot_worktree_tree(cwd, head_tree=candidate_tree, env=exec_env)
        if final_wt_tree != initial_wt_tree:
            ret, diff_summary, _ = run_subprocess_tree_safe(["git", "diff", "--no-color", "--name-status", initial_wt_tree, final_wt_tree], cwd=cwd, env=exec_env)
            print(f"\n❌ [Triad Gate BLOCKED] Validation checks modified working-tree files during verification:\n{diff_summary}", file=sys.stderr)
            sys.exit(1)

        # Filesystem content fingerprint verification: detect any byte-level mutation masked by Git clean/smudge filters
        final_fingerprint = compute_working_tree_fingerprint(cwd, env=exec_env)
        fp_match, mutated = fingerprints_match(initial_fingerprint, final_fingerprint)
        if not fp_match:
            diff_msg = "\n".join(mutated)
            print(f"\n❌ [Triad Gate BLOCKED] Validation checks modified working-tree files during verification:\n{diff_msg}", file=sys.stderr)
            sys.exit(1)

        ret, check_tree, err = run_subprocess_tree_safe(["git", "write-tree"], cwd=cwd, env=exec_env)
        if ret != 0:
            print(f"\n❌ [Triad Gate BLOCKED] Failed to capture verification tree: {err}", file=sys.stderr)
            sys.exit(1)
        if check_tree.strip() != candidate_tree:
            print(f"\n❌ [Triad Gate BLOCKED] Candidate tree changed during validation (expected {candidate_tree}, got {check_tree.strip()}).", file=sys.stderr)
            sys.exit(1)

        # All steps verified clean
        break

    _verify_final_stability(candidate_tree, initial_wt_tree, initial_fingerprint)

    # Step 3: Advisory Council Diff Signoff
    print("\n[Step 3/3] Submitting diff to Advisory Council for pre-commit signoff...")
    try:
        # 1. Determine whether changes exist strictly from tree identity
        if candidate_tree == target_base:
            _verify_final_stability(candidate_tree, initial_wt_tree, initial_fingerprint)
            setattr(args, "_validated_tree", candidate_tree)
            print("✓ No changes detected in git working tree. Gate passed.")
            return

        # 2. Extract immutable unified diff bypassing any external diff drivers or textconv filters
        diff_cmd = ["git", "diff", "--no-color", "--no-ext-diff", "--no-textconv", target_base, candidate_tree, "--"]
        ret, diff, err = run_subprocess_tree_safe(diff_cmd, cwd=cwd, env=exec_env)
        if ret != 0 or not diff or not diff.strip():
            err_msg = err.strip() if err.strip() else "diff produced empty output despite different tree object IDs"
            raise RuntimeError(f"Failed to generate diff against baseline ({target_base[:10]} != {candidate_tree[:10]}): {err_msg}")
        diff = strip_diff_bloat(diff)
    except Exception as e:
        print(f"\n❌ [Triad Gate BLOCKED] Failed to retrieve git diff: {e}", file=sys.stderr)
        sys.exit(1)

    competition = getattr(args, "competition", False)
    if competition:
        try:
            from triad.competition import query_competition_council
        except ImportError:
            from competition import query_competition_council
        adv_pair = ("mock", "mock") if getattr(args, "engine", "auto") == "mock" else ("claude", "codex")
        session = query_competition_council(
            _gate_signoff_prompt(diff, first_line=False)
            + "\nUnder Section 4 (Final Adjudicated Verdict & Action Plan), explicitly state either 'VERDICT: APPROVED' or 'VERDICT: REJECTED'.",
            diff=diff,
            mode="review_diff",
            timeout=getattr(args, "timeout", 240),
            advisor_names=adv_pair
        )
        resp = session.get("synthesis", "")
    else:
        resp = query_advisory_council(
            _gate_signoff_prompt(diff),
            diff=diff,
            mode="review_diff",
            engine=getattr(args, "engine", "auto"),
            timeout=getattr(args, "timeout", 240)
        )
    print("\n[Advisory Council Signoff]:")
    print(resp)

    # Parse verdict fail-closed: distinguish outages from explicit verdicts
    resp_clean = (resp or "").strip()
    if not resp_clean or resp_clean.startswith("[Error") or resp_clean.startswith("[error"):
        print("\n❌ [Triad Gate BLOCKED] Advisory Council execution error or service outage.")
        if resp_clean:
            print(f"Details: {resp_clean[:200]}")
        sys.exit(1)

    # Rejection anywhere in the response takes precedence and immediately blocks
    is_rejected = bool(re.search(r"\bVERDICT:\s*REJECTED\b", resp_clean, re.IGNORECASE))
    if is_rejected:
        print("\n❌ [Triad Gate BLOCKED] Advisory Council explicitly rejected the diff.")
        print("Address the advisory council findings above before committing.")
        notify_event("Pre-Commit Gate Rejected", "Advisory Council explicitly rejected the diff.", status="failed", timeout=1.5)
        sys.exit(1)

    if competition:
        is_approved = bool(re.search(r"\bVERDICT:\s*APPROVED\b", resp_clean, re.IGNORECASE))
    else:
        # Approval must be explicitly declared on the opening non-empty line of the active advisor response
        non_empty_lines = [l.strip() for l in resp_clean.splitlines() if l.strip()]
        while non_empty_lines and non_empty_lines[0].startswith("[") and ("failover" in non_empty_lines[0].lower() or "auto-failover" in non_empty_lines[0].lower()):
            non_empty_lines.pop(0)
        first_line = non_empty_lines[0] if non_empty_lines else ""
        first_line_clean = re.sub(r"[\*#_`]", "", first_line).strip()
        is_approved = bool(re.match(r"^VERDICT:\s*APPROVED\b", first_line_clean, re.IGNORECASE))

    if is_approved:
        # Common final stability check: verify both working tree and index did not mutate
        _verify_final_stability()
        setattr(args, "_validated_tree", candidate_tree)
        print("\n✓ [Triad Gate COMPLETE] Advisory Council approved pre-commit signoff.")
    else:
        reason = "contain 'VERDICT: APPROVED'" if competition else "provide an explicit 'VERDICT: APPROVED' on line 1"
        print(f"\n❌ [Triad Gate BLOCKED] Advisory Council did not {reason}.")
        print("Address the advisory council findings above before committing.")
        notify_event("Pre-Commit Gate Blocked", f"Advisory Council did not approve diff: {reason}.", status="failed", timeout=1.5)
        sys.exit(1)

def _gate_signoff_prompt(diff: str, *, first_line: bool = True) -> str:
    """Stable pre-commit checklist. Truncation is named, and is not itself a rejection."""
    files = []
    for line in (diff or "").splitlines():
        if line.startswith("diff --git "):
            files.append(line[len("diff --git "):])
    index = "\n".join(f"- {name}" for name in files[:100]) or "- (no file headers)"
    verdict_line = (
        "Start your response with exactly 'VERDICT: APPROVED' or 'VERDICT: REJECTED' on the first line.\n"
        if first_line else ""
    )
    return (
        "Evaluate this diff as the final pre-commit gate.\n"
        f"{verdict_line}"
        "Checklist: correctness of the changed lines; regressions in direct callers; "
        "data-loss or secret exposure; security of file and process handling.\n"
        "Do not reject for wording or for files that were not shown. "
        "If the diff was truncated, judge the files you can see and name what you could not review. "
        "Truncation alone is not a reason to reject.\n"
        f"Files in this diff:\n{index}\n"
    )


def cmd_bench(args):
    """Run the Triad benchmark suite."""
    suite = getattr(args, "suite", "cases")
    if suite == "swebench":
        try:
            from bench.swebench_runner import run_swebench
        except ImportError:
            from triad.bench.swebench_runner import run_swebench

        run_swebench(
            engine=args.engine,
            limit=args.limit or 5,
            instance_id=args.case,
            mode="debug",
            judge_engine=getattr(args, "judge_engine", "claude"),
            workers=getattr(args, "workers", 2),
            verbose=args.verbose,
            docker_mode=getattr(args, "docker", "off"),
        )
        return

    try:
        from bench.run_bench import run_benchmark, DEFAULT_CASES_DIR
    except ImportError:
        from triad.bench.run_bench import run_benchmark, DEFAULT_CASES_DIR

    cases_dir = Path(args.cases_dir) if args.cases_dir else DEFAULT_CASES_DIR
    bugs_caught, pos_tot, fps, neg_tot, results = run_benchmark(
        cases_dir=cases_dir,
        engine=args.engine,
        limit=args.limit,
        case_id=args.case,
        judge_engine=getattr(args, "judge_engine", "claude"),
        verbose=args.verbose
    )

def cmd_worktree(args):
    """Manage ephemeral git worktrees."""
    action = getattr(args, "wt_action", None)
    if action == "list" or not action:
        wts = list_worktrees()
        print(f"Active Git Worktrees ({len(wts)}):")
        for wt in wts:
            det = " (detached)" if wt.get("detached") else ""
            branch = f" [{wt.get('branch')}]" if wt.get("branch") else ""
            print(f"  - {wt['worktree']} {wt.get('head', '')[:8]}{branch}{det}")
    elif action == "create":
        wt_path = create_worktree(".", branch_or_commit=args.ref, prefix=args.prefix)
        print(f"Created isolated worktree at: {wt_path}")
    elif action == "remove":
        removed = remove_worktree(args.path, force=args.force)
        if removed:
            print(f"Removed worktree at: {args.path}")
        else:
            print(f"Failed to remove worktree at: {args.path}")
    elif action == "prune":
        prune_worktrees(".")
        print("Pruned stale worktree metadata.")

def cmd_auto(args, env: Optional[Dict[str, str]] = None):
    """
    Auto-classify intent and autonomously route to the appropriate subsystem.
    Supports isolated worktree execution via --worktree (-w).
    """
    if getattr(args, "classify_only", False):
        _print_classification_only(args)
        return

    _check_apply_verified_safety(args, env)

    if getattr(args, "worktree", False):
        try:
            repo_root = get_repo_root(".", env=env)
        except Exception as e:
            print(f"[Triad Worktree Error] Not inside a git repository: {e}", file=sys.stderr)
            sys.exit(1)

        _run_in_isolated_worktree(
            args, env,
            repo_root=repo_root,
            prefix="triad-auto",
            require_index=False,
            runner=lambda a, e: _run_auto(a, env=e),
            error_label="Triad Worktree Error",
            phase_label="auto execution",
            nm_phase_label="auto-execution",
            enforce_clean_explicit_ref=True,
            pause_commit_after_apply=False,
            notify_async=False,
        )
        return

    _run_auto(args, env=env)


def _resolve_auto_inputs(args) -> Tuple[str, str, Optional[str]]:
    """Normalize the (prompt, diff, context) triple that ``triad auto`` classifies."""
    diff_file = getattr(args, "diff_file", None)
    stdin_is_diff = diff_file == "-"

    prompt = getattr(args, "prompt", "")
    if isinstance(prompt, list):
        prompt = " ".join(prompt).strip()
    # stdin can only be consumed once: when it carries the diff, never read it as the prompt.
    if not prompt and not stdin_is_diff and not sys.stdin.isatty():
        prompt = sys.stdin.read().strip()
    setattr(args, "prompt", prompt)

    diff_content = ""
    if diff_file:
        if stdin_is_diff:
            diff_content = sys.stdin.read()
        elif os.path.exists(diff_file):
            with open(diff_file, "r", encoding="utf-8", errors="replace") as f:
                diff_content = f.read()

    context = getattr(args, "context", None) or None
    context_file = getattr(args, "context_file", "")
    if context_file and os.path.exists(context_file):
        with open(context_file, "r", encoding="utf-8", errors="replace") as f:
            context = f.read()
    return prompt, diff_content, context


def _print_classification_only(args) -> None:
    """``triad auto --classify-only``: emit the intent decision as JSON without executing it."""
    prompt, diff_content, context = _resolve_auto_inputs(args)
    classification = classify_intent(prompt, context=context, diff=diff_content)
    if getattr(args, "competition", False):
        classification.suggested_engine = "competition"
    payload = {
        "intent": classification.intent,
        "confidence": classification.confidence,
        "reason": classification.reason,
        "suggested_mode": classification.suggested_mode,
        "suggested_engine": classification.suggested_engine,
        "high_stakes": classification.high_stakes,
        "metadata": classification.metadata,
    }
    print(json.dumps(payload, indent=2))


def _run_auto(args, env: Optional[Dict[str, str]] = None):
    prompt, diff_content, context = _resolve_auto_inputs(args)
    classification = classify_intent(prompt, context=context, diff=diff_content)

    # Force competition if user passed flag
    if getattr(args, "competition", False):
        classification.suggested_engine = "competition"

    execute_intent(classification, prompt, args, env=env)


def cmd_listen(args):
    """Start the Triad Ambient HTTP server daemon."""
    try:
        from triad.server import start_server
    except ImportError:
        from server import start_server

    port = getattr(args, "port", 8789)
    host = getattr(args, "host", "127.0.0.1")
    start_server(host=host, port=port)


TRIAD_HOOK_SIGNATURE = "# Triad Autonomous Pre-Commit Gate Hook"
TRIAD_USER_WRAPPER_START = "# --- Triad Execution Wrapper [START] ---"
TRIAD_USER_WRAPPER_END = "# --- Triad Execution Wrapper [END] ---"
TRIAD_USER_BODY_START = "# --- Triad User Hook Body [START] ---"
TRIAD_USER_BODY_END = "# --- Triad User Hook Body [END] ---"


def _render_triad_hook_block(backup_name: Optional[str] = None) -> str:
    owned_tag = f"# TRIAD_BACKUP_OWNED: {backup_name or 'none'}\n"
    return (
        f"# --- {TRIAD_HOOK_SIGNATURE} [START] ---\n"
        f"{owned_tag}"
        f"USER_EXIT=$?\n"
        f"if [ $USER_EXIT -ne 0 ]; then\n"
        f"    exit $USER_EXIT\n"
        f"fi\n"
        f'TRIAD_HOOK_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"\n'
        f'if [ "${{TRIAD_GATE_ACTIVE:-}}" != "1" ]; then\n'
        f"    if command -v triad >/dev/null 2>&1; then\n"
        f"        triad gate --worktree --apply-verified || exit $?\n"
        f"    elif command -v triad.cmd >/dev/null 2>&1; then\n"
        f"        triad.cmd gate --worktree --apply-verified || exit $?\n"
        f'    elif command -v python3 >/dev/null 2>&1 && python3 -c "import triad" >/dev/null 2>&1; then\n'
        f"        python3 -m triad gate --worktree --apply-verified || exit $?\n"
        f'    elif command -v python >/dev/null 2>&1 && python -c "import triad" >/dev/null 2>&1; then\n'
        f"        python -m triad gate --worktree --apply-verified || exit $?\n"
        f"    else\n"
        f'        if [ "${{TRIAD_SKIP_MISSING:-0}}" = "1" ] || [ "${{TRIAD_OPTIONAL:-0}}" = "1" ]; then\n'
        f'            echo "⚠️ [Triad Hook Notice] Triad CLI not detected on this system. Skipping autonomous gate (TRIAD_SKIP_MISSING / TRIAD_OPTIONAL set)."\n'
        f"        else\n"
        f'            echo "❌ [Triad Hook Error] Triad CLI not found on PATH or via python module."\n'
        f'            echo "To fix: Ensure \'triad\' is on PATH, or run: python -m triad hook install"\n'
        f'            echo "To bypass intentionally for this commit, run: git commit --no-verify or set TRIAD_SKIP_MISSING=1"\n'
        f"            exit 1\n"
        f"        fi\n"
        f"    fi\n"
        f"fi\n"
        f"# --- {TRIAD_HOOK_SIGNATURE} [END] ---\n"
    )

TRIAD_HOOK_BLOCK = _render_triad_hook_block("none")


def _render_hook_template(backup_name: Optional[str] = "pre-commit.legacy", should_execute_backup: bool = True) -> str:
    hook_block = _render_triad_hook_block(backup_name)
    owned_val = backup_name or "none"
    owned_tag = f"# TRIAD_BACKUP_OWNED: {owned_val}\n"
    active_val = "1" if should_execute_backup else "0"
    active_tag = f"# TRIAD_BACKUP_ACTIVE: {active_val}\n"
    return f"""#!/bin/sh
{TRIAD_HOOK_SIGNATURE}
{owned_tag}{active_tag}# Automatically verifies type safety, test suites, and Advisory Council review in an isolated worktree.

HOOK_DIR=$(dirname "$0")

# 1. Execute explicitly owned legacy/third-party pre-commit hook first
BACKUP_ACTIVE="{active_val}"
OWNED_BACKUP="{backup_name or ''}"
if [ "$BACKUP_ACTIVE" = "1" ]; then
    if [ -z "$OWNED_BACKUP" ]; then
        if [ -f "$HOOK_DIR/pre-commit.legacy" ] || [ -L "$HOOK_DIR/pre-commit.legacy" ]; then
            OWNED_BACKUP="pre-commit.legacy"
        fi
    fi
    if [ -n "$OWNED_BACKUP" ] && [ "$OWNED_BACKUP" != "none" ]; then
        legacy_hook="$HOOK_DIR/$OWNED_BACKUP"
        if [ ! -e "$legacy_hook" ] && [ ! -L "$legacy_hook" ]; then
            _COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || git rev-parse --git-dir 2>/dev/null || echo "")
            if [ -n "$_COMMON_DIR" ] && ( [ -e "$_COMMON_DIR/hooks/$OWNED_BACKUP" ] || [ -L "$_COMMON_DIR/hooks/$OWNED_BACKUP" ] ); then
                legacy_hook="$_COMMON_DIR/hooks/$OWNED_BACKUP"
            fi
        fi
        if [ ! -e "$legacy_hook" ] && [ ! -L "$legacy_hook" ]; then
            echo "❌ [Triad Hook Error] Expected legacy pre-commit hook '$OWNED_BACKUP' is missing." >&2
            exit 1
        fi
        if [ -L "$legacy_hook" ] && [ ! -e "$legacy_hook" ]; then
            echo "❌ [Triad Hook Error] Legacy pre-commit hook '$OWNED_BACKUP' is a dangling symlink." >&2
            exit 1
        fi
        IS_HUSKY=0
        if [ "$(basename "$HOOK_DIR")" = ".husky" ] || [ -f "$HOOK_DIR/../.husky/_/h" ] || [ -d "$HOOK_DIR/../.husky" ]; then
            IS_HUSKY=1
        fi
        if [ ! -x "$legacy_hook" ] && [ "$IS_HUSKY" -ne 1 ]; then
            echo "❌ [Triad Hook Error] Legacy pre-commit hook '$OWNED_BACKUP' is not executable." >&2
            exit 1
        fi
        if grep -q "Triad Autonomous Pre-Commit Gate Hook" "$legacy_hook" 2>/dev/null; then
            echo "❌ [Triad Hook Error] Circular legacy hook execution detected in '$OWNED_BACKUP'." >&2
            exit 1
        fi

        LEGACY_DIR=$(cd "$(dirname "$legacy_hook")" && pwd)
        legacy_hook="$LEGACY_DIR/$(basename "$legacy_hook")"
        TARGET_HOOK="$HOOK_DIR/pre-commit"
        export TARGET_HOOK
        TRIAD_ORIGINAL_HOOK="$HOOK_DIR/pre-commit"
        export TRIAD_ORIGINAL_HOOK

        if [ $# -gt 16 ]; then
            echo "❌ [Triad Hook Error] Pre-commit hook arguments exceed maximum supported count (16)." >&2
            exit 1
        fi

        _TRIAD_ORIG_COUNT=$#
        _idx=1
        for _a in "$@"; do
            case $_idx in
                1) _TRIAD_ARG_1="$_a" ;; 2) _TRIAD_ARG_2="$_a" ;; 3) _TRIAD_ARG_3="$_a" ;; 4) _TRIAD_ARG_4="$_a" ;;
                5) _TRIAD_ARG_5="$_a" ;; 6) _TRIAD_ARG_6="$_a" ;; 7) _TRIAD_ARG_7="$_a" ;; 8) _TRIAD_ARG_8="$_a" ;;
                9) _TRIAD_ARG_9="$_a" ;; 10) _TRIAD_ARG_10="$_a" ;; 11) _TRIAD_ARG_11="$_a" ;; 12) _TRIAD_ARG_12="$_a" ;;
                13) _TRIAD_ARG_13="$_a" ;; 14) _TRIAD_ARG_14="$_a" ;; 15) _TRIAD_ARG_15="$_a" ;; 16) _TRIAD_ARG_16="$_a" ;;
            esac
            _idx=$((_idx + 1))
        done

        _triad_exec_split_args() {{
            "$@"
            return $?
        }}

        FIRST_LINE=$(head -n 1 "$legacy_hook" 2>/dev/null || true)
        case "$FIRST_LINE" in
            "#!"*)
                RAW_INTERP=$(printf '%s\\n' "$FIRST_LINE" | sed -e 's/^#![[:blank:]]*//')
                ;;
            *)
                RAW_INTERP=""
                ;;
        esac

        _triad_parse_shebang_tokens() {{
            _raw=$(printf '%s\\n' "$1" | tr "\\\\\\\\" "/")
            _TOK_COUNT=0
            _rem="$_raw"
            _cur=""
            _has=0
            _in_sq=0
            _in_dq=0
            _esc=0

            _add_tok() {{
                if [ $_TOK_COUNT -ge 16 ]; then
                    echo "❌ [Triad Hook Error] Legacy shebang exceeds maximum supported token count (16)." >&2
                    exit 1
                fi
                _TOK_COUNT=$((_TOK_COUNT + 1))
                case $_TOK_COUNT in
                    1) _TOK_1="$1" ;; 2) _TOK_2="$1" ;; 3) _TOK_3="$1" ;; 4) _TOK_4="$1" ;;
                    5) _TOK_5="$1" ;; 6) _TOK_6="$1" ;; 7) _TOK_7="$1" ;; 8) _TOK_8="$1" ;;
                    9) _TOK_9="$1" ;; 10) _TOK_10="$1" ;; 11) _TOK_11="$1" ;; 12) _TOK_12="$1" ;;
                    13) _TOK_13="$1" ;; 14) _TOK_14="$1" ;; 15) _TOK_15="$1" ;; 16) _TOK_16="$1" ;;
                esac
            }}

            set -f
            while [ -n "$_rem" ]; do
                _c="${{_rem%"${{_rem#?}}"}}"
                _rem="${{_rem#?}}"
                if [ "$_esc" -eq 1 ]; then
                    _cur="${{_cur}}${{_c}}"
                    _has=1
                    _esc=0
                elif [ "$_in_sq" -eq 1 ]; then
                    if [ "$_c" = "'" ]; then
                        _in_sq=0
                    else
                        _cur="${{_cur}}${{_c}}"
                    fi
                elif [ "$_in_dq" -eq 1 ]; then
                    if [ "$_c" = '\\' ]; then
                        _esc=1
                    elif [ "$_c" = '"' ]; then
                        _in_dq=0
                    else
                        _cur="${{_cur}}${{_c}}"
                    fi
                else
                    if [ "$_c" = '\\' ]; then
                        _has=1
                        _esc=1
                    elif [ "$_c" = "'" ]; then
                        _has=1
                        _in_sq=1
                    elif [ "$_c" = '"' ]; then
                        _has=1
                        _in_dq=1
                    elif [ "$_c" = " " ] || [ "$_c" = "	" ]; then
                        if [ "$_has" -eq 1 ]; then
                            _add_tok "$_cur"
                            _cur=""
                            _has=0
                        fi
                    else
                        _cur="${{_cur}}${{_c}}"
                        _has=1
                    fi
                fi
            done
            if [ "$_has" -eq 1 ]; then
                _add_tok "$_cur"
            fi
            set +f
        }}

        _triad_get_token() {{
            case "$1" in
                1) _TOK_VAL="$_TOK_1" ;; 2) _TOK_VAL="$_TOK_2" ;; 3) _TOK_VAL="$_TOK_3" ;; 4) _TOK_VAL="$_TOK_4" ;;
                5) _TOK_VAL="$_TOK_5" ;; 6) _TOK_VAL="$_TOK_6" ;; 7) _TOK_VAL="$_TOK_7" ;; 8) _TOK_VAL="$_TOK_8" ;;
                9) _TOK_VAL="$_TOK_9" ;; 10) _TOK_VAL="$_TOK_10" ;; 11) _TOK_VAL="$_TOK_11" ;; 12) _TOK_VAL="$_TOK_12" ;;
                13) _TOK_VAL="$_TOK_13" ;; 14) _TOK_VAL="$_TOK_14" ;; 15) _TOK_VAL="$_TOK_15" ;; 16) _TOK_VAL="$_TOK_16" ;;
                *) _TOK_VAL="" ;;
            esac
        }}

        _triad_parse_shebang_tokens "$RAW_INTERP"

        _cur_idx=1
        _use_env=0
        _INTERP_BIN=""
        _ENV_OPT_COUNT=0
        _FLAG_COUNT=0

        _add_env_opt() {{
            if [ $_ENV_OPT_COUNT -ge 16 ]; then
                echo "❌ [Triad Hook Error] Legacy shebang exceeds maximum supported env options (16)." >&2
                exit 1
            fi
            _ENV_OPT_COUNT=$((_ENV_OPT_COUNT + 1))
            case $_ENV_OPT_COUNT in
                1) _ENV_OPT_1="$1" ;; 2) _ENV_OPT_2="$1" ;; 3) _ENV_OPT_3="$1" ;; 4) _ENV_OPT_4="$1" ;;
                5) _ENV_OPT_5="$1" ;; 6) _ENV_OPT_6="$1" ;; 7) _ENV_OPT_7="$1" ;; 8) _ENV_OPT_8="$1" ;;
                9) _ENV_OPT_9="$1" ;; 10) _ENV_OPT_10="$1" ;; 11) _ENV_OPT_11="$1" ;; 12) _ENV_OPT_12="$1" ;;
                13) _ENV_OPT_13="$1" ;; 14) _ENV_OPT_14="$1" ;; 15) _ENV_OPT_15="$1" ;; 16) _ENV_OPT_16="$1" ;;
            esac
        }}

        _add_flag() {{
            if [ $_FLAG_COUNT -ge 16 ]; then
                echo "❌ [Triad Hook Error] Legacy shebang exceeds maximum supported flags (16)." >&2
                exit 1
            fi
            _FLAG_COUNT=$((_FLAG_COUNT + 1))
            case $_FLAG_COUNT in
                1) _FLAG_1="$1" ;; 2) _FLAG_2="$1" ;; 3) _FLAG_3="$1" ;; 4) _FLAG_4="$1" ;;
                5) _FLAG_5="$1" ;; 6) _FLAG_6="$1" ;; 7) _FLAG_7="$1" ;; 8) _FLAG_8="$1" ;;
                9) _FLAG_9="$1" ;; 10) _FLAG_10="$1" ;; 11) _FLAG_11="$1" ;; 12) _FLAG_12="$1" ;;
                13) _FLAG_13="$1" ;; 14) _FLAG_14="$1" ;; 15) _FLAG_15="$1" ;; 16) _FLAG_16="$1" ;;
            esac
        }}

        if [ $_TOK_COUNT -gt 0 ]; then
            _triad_get_token 1
            _first_base=$(basename "$_TOK_VAL" 2>/dev/null || printf '%s\\n' "$_TOK_VAL")
            if [ "$_first_base" = "env" ]; then
                _use_env=1
                _cur_idx=2
                while [ $_cur_idx -le $_TOK_COUNT ]; do
                    _triad_get_token $_cur_idx
                    _cur_idx=$((_cur_idx + 1))
                    case "$_TOK_VAL" in
                        -S|--split-string)
                            ;;
                        -i|--ignore-environment)
                            _add_env_opt "-i"
                            ;;
                        -u)
                            _add_env_opt "-u"
                            if [ $_cur_idx -le $_TOK_COUNT ]; then
                                _triad_get_token $_cur_idx
                                _cur_idx=$((_cur_idx + 1))
                                _add_env_opt "$_TOK_VAL"
                            fi
                            ;;
                        *=*)
                            _add_env_opt "$_TOK_VAL"
                            ;;
                        -*)
                            ;;
                        *)
                            _INTERP_BIN="$_TOK_VAL"
                            break
                            ;;
                    esac
                done
            else
                _INTERP_BIN="$_TOK_VAL"
                _cur_idx=2
            fi
            while [ $_cur_idx -le $_TOK_COUNT ]; do
                _triad_get_token $_cur_idx
                _cur_idx=$((_cur_idx + 1))
                _add_flag "$_TOK_VAL"
            done
        fi

        set -f
        set --
        if [ "$_use_env" -eq 1 ]; then
            set -- "$@" "env"
            _eidx=1
            while [ $_eidx -le $_ENV_OPT_COUNT ]; do
                case $_eidx in
                    1) set -- "$@" "$_ENV_OPT_1" ;; 2) set -- "$@" "$_ENV_OPT_2" ;;
                    3) set -- "$@" "$_ENV_OPT_3" ;; 4) set -- "$@" "$_ENV_OPT_4" ;;
                    5) set -- "$@" "$_ENV_OPT_5" ;; 6) set -- "$@" "$_ENV_OPT_6" ;;
                    7) set -- "$@" "$_ENV_OPT_7" ;; 8) set -- "$@" "$_ENV_OPT_8" ;;
                    9) set -- "$@" "$_ENV_OPT_9" ;; 10) set -- "$@" "$_ENV_OPT_10" ;;
                    11) set -- "$@" "$_ENV_OPT_11" ;; 12) set -- "$@" "$_ENV_OPT_12" ;;
                    13) set -- "$@" "$_ENV_OPT_13" ;; 14) set -- "$@" "$_ENV_OPT_14" ;;
                    15) set -- "$@" "$_ENV_OPT_15" ;; 16) set -- "$@" "$_ENV_OPT_16" ;;
                esac
                _eidx=$((_eidx + 1))
            done
        fi

        _interp_base=$(basename "$_INTERP_BIN" 2>/dev/null || printf '%s\\n' "$_INTERP_BIN")
        _interp_base_lower=$(printf '%s\\n' "$_interp_base" | tr '[:upper:]' '[:lower:]')

        case "$_interp_base_lower" in
            sh|bash|zsh|dash|ash|ksh)
                _cmd="${{_INTERP_BIN:-sh}}"
                set -- "$@" "$_cmd"
                _fidx=1
                while [ $_fidx -le $_FLAG_COUNT ]; do
                    case $_fidx in
                        1) set -- "$@" "$_FLAG_1" ;; 2) set -- "$@" "$_FLAG_2" ;; 3) set -- "$@" "$_FLAG_3" ;; 4) set -- "$@" "$_FLAG_4" ;;
                        5) set -- "$@" "$_FLAG_5" ;; 6) set -- "$@" "$_FLAG_6" ;; 7) set -- "$@" "$_FLAG_7" ;; 8) set -- "$@" "$_FLAG_8" ;;
                        9) set -- "$@" "$_FLAG_9" ;; 10) set -- "$@" "$_FLAG_10" ;; 11) set -- "$@" "$_FLAG_11" ;; 12) set -- "$@" "$_FLAG_12" ;;
                        13) set -- "$@" "$_FLAG_13" ;; 14) set -- "$@" "$_FLAG_14" ;; 15) set -- "$@" "$_FLAG_15" ;; 16) set -- "$@" "$_FLAG_16" ;;
                    esac
                    _fidx=$((_fidx + 1))
                done
                set -- "$@" -c 'script="$1"; shift; . "$script"' "$HOOK_DIR/pre-commit" "$legacy_hook"
                ;;
            python*|pypy*)
                _cmd="${{_INTERP_BIN:-python3}}"
                set -- "$@" "$_cmd"
                _fidx=1
                while [ $_fidx -le $_FLAG_COUNT ]; do
                    case $_fidx in
                        1) set -- "$@" "$_FLAG_1" ;; 2) set -- "$@" "$_FLAG_2" ;; 3) set -- "$@" "$_FLAG_3" ;; 4) set -- "$@" "$_FLAG_4" ;;
                        5) set -- "$@" "$_FLAG_5" ;; 6) set -- "$@" "$_FLAG_6" ;; 7) set -- "$@" "$_FLAG_7" ;; 8) set -- "$@" "$_FLAG_8" ;;
                        9) set -- "$@" "$_FLAG_9" ;; 10) set -- "$@" "$_FLAG_10" ;; 11) set -- "$@" "$_FLAG_11" ;; 12) set -- "$@" "$_FLAG_12" ;;
                        13) set -- "$@" "$_FLAG_13" ;; 14) set -- "$@" "$_FLAG_14" ;; 15) set -- "$@" "$_FLAG_15" ;; 16) set -- "$@" "$_FLAG_16" ;;
                    esac
                    _fidx=$((_fidx + 1))
                done
                set -- "$@" -c 'import os, sys; orig = sys.argv[1]; p = sys.argv[2]; sys.argv = [orig] + sys.argv[3:]; sys.path[0] = os.path.dirname(os.path.abspath(orig)); bp = os.path.dirname(os.path.abspath(p)); sys.path.insert(1, bp) if bp != sys.path[0] else None; m = sys.modules["__main__"]; m.__file__ = orig; f = open(p, "rb"); c = compile(f.read(), orig, "exec"); f.close(); exec(c, m.__dict__)' "$HOOK_DIR/pre-commit" "$legacy_hook"
                ;;
            *)
                if [ -n "$_INTERP_BIN" ]; then
                    set -- "$@" "$_INTERP_BIN"
                    _fidx=1
                    while [ $_fidx -le $_FLAG_COUNT ]; do
                        case $_fidx in
                            1) set -- "$@" "$_FLAG_1" ;; 2) set -- "$@" "$_FLAG_2" ;; 3) set -- "$@" "$_FLAG_3" ;; 4) set -- "$@" "$_FLAG_4" ;;
                            5) set -- "$@" "$_FLAG_5" ;; 6) set -- "$@" "$_FLAG_6" ;; 7) set -- "$@" "$_FLAG_7" ;; 8) set -- "$@" "$_FLAG_8" ;;
                            9) set -- "$@" "$_FLAG_9" ;; 10) set -- "$@" "$_FLAG_10" ;; 11) set -- "$@" "$_FLAG_11" ;; 12) set -- "$@" "$_FLAG_12" ;;
                            13) set -- "$@" "$_FLAG_13" ;; 14) set -- "$@" "$_FLAG_14" ;; 15) set -- "$@" "$_FLAG_15" ;; 16) set -- "$@" "$_FLAG_16" ;;
                        esac
                        _fidx=$((_fidx + 1))
                    done
                    set -- "$@" "$legacy_hook"
                elif [ -x "$legacy_hook" ]; then
                    set -- "$@" "$legacy_hook"
                else
                    set -- "$@" "sh" -c 'script="$1"; shift; . "$script"' "$HOOK_DIR/pre-commit" "$legacy_hook"
                fi
                ;;
        esac

        _idx=1
        while [ $_idx -le $_TRIAD_ORIG_COUNT ]; do
            case $_idx in
                1) set -- "$@" "$_TRIAD_ARG_1" ;; 2) set -- "$@" "$_TRIAD_ARG_2" ;;
                3) set -- "$@" "$_TRIAD_ARG_3" ;; 4) set -- "$@" "$_TRIAD_ARG_4" ;;
                5) set -- "$@" "$_TRIAD_ARG_5" ;; 6) set -- "$@" "$_TRIAD_ARG_6" ;;
                7) set -- "$@" "$_TRIAD_ARG_7" ;; 8) set -- "$@" "$_TRIAD_ARG_8" ;;
                9) set -- "$@" "$_TRIAD_ARG_9" ;; 10) set -- "$@" "$_TRIAD_ARG_10" ;;
                11) set -- "$@" "$_TRIAD_ARG_11" ;; 12) set -- "$@" "$_TRIAD_ARG_12" ;;
                13) set -- "$@" "$_TRIAD_ARG_13" ;; 14) set -- "$@" "$_TRIAD_ARG_14" ;;
                15) set -- "$@" "$_TRIAD_ARG_15" ;; 16) set -- "$@" "$_TRIAD_ARG_16" ;;
            esac
            _idx=$((_idx + 1))
        done

        set +f

        # Dispatch via _triad_exec_split_args compatibility wrapper -- "$@"
        _triad_exec_split_args "$@"
        LEGACY_EXIT=$?
        if [ $LEGACY_EXIT -ne 0 ]; then
            echo "[Triad Hook] Legacy pre-commit hook $(basename "$legacy_hook") failed (exit code $LEGACY_EXIT). Aborting commit."
            exit $LEGACY_EXIT
        fi
    fi
fi

# 2. Pre-commit gate enforcement
{hook_block}
"""

TRIAD_HOOK_TEMPLATE = _render_hook_template("none")


def get_git_common_dir(repo_path: Union[str, Path] = ".") -> Path:
    """Resolve the common git directory for a repo or linked worktree."""
    ret_c, out_c, _ = run_subprocess_tree_safe(["git", "rev-parse", "--git-common-dir"], cwd=repo_path)
    if ret_c == 0 and out_c.strip():
        p = Path(out_c.strip())
        if not p.is_absolute():
            p = (Path(repo_path) / p).resolve()
        return p
    ret_g, out_g, _ = run_subprocess_tree_safe(["git", "rev-parse", "--git-dir"], cwd=repo_path)
    if ret_g == 0 and out_g.strip():
        p = Path(out_g.strip())
        if not p.is_absolute():
            p = (Path(repo_path) / p).resolve()
        return p
    return (Path(repo_path) / ".git").resolve()


def get_git_hooks_dir(repo_path: str = ".") -> Path:
    """Resolve the git hooks directory for a repo or worktree."""
    ret, out, _ = run_subprocess_tree_safe(["git", "rev-parse", "--git-path", "hooks"], cwd=repo_path)
    if ret == 0 and out.strip():
        p = Path(out.strip())
        if not p.is_absolute():
            p = (Path(repo_path) / p).resolve()
        return p
    return (Path(repo_path) / ".git" / "hooks").resolve()


def resolve_target_hook_file(repo_root: Union[str, Path], hook_name: str = "pre-commit") -> Path:
    """
    Resolve the actual hook script to install into or manage.
    Handles standard git hooks, custom core.hooksPath, and modern Husky v9 bootstrap layouts.
    Strictly follows Git's effective hooks directory. Redirects to .husky only when Git's
    active hook entrypoint or core.hooksPath demonstrably delegates to Husky.
    Preserves symlinks on .husky hooks without resolving them to underlying targets.
    """
    repo_root = Path(repo_root).resolve()
    hooks_dir = get_git_hooks_dir(repo_root)
    primary_hook = hooks_dir / hook_name

    # Check for modern Husky layout:
    # Redirect to .husky only when Git's active hook entrypoint or core.hooksPath demonstrably delegates to Husky.
    # 1. hooks_dir is literally within .husky ('_') or is .husky
    if hooks_dir.name == "_" and hooks_dir.parent.name == ".husky":
        return hooks_dir.parent / hook_name
    if hooks_dir.name == ".husky":
        return hooks_dir / hook_name

    # 2. primary_hook delegates to a bootstrap like "${0%/*}/h" or "/_/h" or "husky.sh"
    if primary_hook.exists():
        try:
            content = primary_hook.read_text(encoding="utf-8", errors="replace")
            if "${0%/*}/h" in content or "/_/h" in content or "husky.sh" in content:
                husky_user_hook = repo_root / ".husky" / hook_name
                if husky_user_hook != primary_hook and (husky_user_hook.is_symlink() or husky_user_hook.exists() or (repo_root / ".husky" / "_").exists()):
                    return husky_user_hook
        except Exception:
            pass

    return primary_hook


def is_posix_shell_shebang(first_line: str) -> bool:
    """
    Check if the first line is a valid shebang for a POSIX-compatible shell.
    Strictly allowlists POSIX shells: sh, bash, zsh, dash, ash, ksh.
    Rejects fish, pwsh, python, node, perl, ruby, etc.
    """
    if not first_line.startswith("#!"):
        return False
    m = re.search(r"^#!\s*(?:[^\s]*/env(?:\s+-\S+)*\s+)?([^\s]+)", first_line)
    if not m:
        return False
    interp = Path(m.group(1)).name.lower()
    return interp in {"sh", "bash", "zsh", "dash", "ash", "ksh"}


def _has_top_level_return(content: str) -> bool:
    """
    Detect if a shell script contains a top-level 'return' statement (outside function definitions).
    Scripts containing top-level returns are meant to be sourced, and fail inside subshells.
    """
    if not re.search(r"\breturn\b", content):
        return False

    func_depth = 0
    in_func_header = False

    for line in content.splitlines():
        code_part = re.sub(r"#.*$", "", line).strip()
        if not code_part:
            continue

        if re.search(r"(?:function\s+\w+|\w+\s*\(\s*\))\s*\{?", code_part):
            in_func_header = True

        for char in code_part:
            if char == "{" and in_func_header:
                func_depth += 1
                in_func_header = False
            elif char == "}" and func_depth > 0:
                func_depth -= 1

        if func_depth == 0 and re.search(r"\breturn\b", code_part):
            return True

    return False


def _unwrap_triad_user_body(content: str) -> str:
    """
    Extracts and unwraps the original user hook body from a Triad-wrapped hook.
    Strips any trailing Triad pre-commit gate hook block, then unwraps the execution wrapper.
    Uses explicit TRIAD_USER_BODY_START and TRIAD_USER_BODY_END boundary markers to prevent
    truncation or corruption if the user hook body contains inner subshells with ')' or 'USER_EXIT=$?'.
    Validates that markers appear with unambiguous multiplicity (count == 1).
    Falls back gracefully to legacy wrapper regex if body boundary markers are not present.
    """
    import re
    # 1. Strip any existing Triad pre-commit gate block
    content = re.sub(
        r"\n?# --- # Triad Autonomous Pre-Commit Gate Hook \[START\] ---.*?# --- # Triad Autonomous Pre-Commit Gate Hook \[END\] ---\n?",
        "",
        content,
        flags=re.DOTALL
    )

    if TRIAD_USER_WRAPPER_START not in content:
        return content

    if (
        TRIAD_USER_BODY_START in content
        and TRIAD_USER_BODY_END in content
        and content.count(TRIAD_USER_BODY_START) == 1
        and content.count(TRIAD_USER_BODY_END) == 1
    ):
        wrap_start = content.find(TRIAD_USER_WRAPPER_START)
        wrap_end = content.find(TRIAD_USER_WRAPPER_END)
        body_start = content.find(TRIAD_USER_BODY_START)
        body_end = content.find(TRIAD_USER_BODY_END)

        if 0 <= wrap_start < body_start < body_end and wrap_end > body_end:
            body_inner_start = body_start + len(TRIAD_USER_BODY_START)
            raw_body = content[body_inner_start:body_end]
            if raw_body.startswith("\r\n"):
                raw_body = raw_body[2:]
            elif raw_body.startswith("\n"):
                raw_body = raw_body[1:]
            if raw_body.endswith("\r\n"):
                raw_body = raw_body[:-2]
            elif raw_body.endswith("\n"):
                raw_body = raw_body[:-1]

            prefix = content[:wrap_start]
            wrap_full_end = wrap_end + len(TRIAD_USER_WRAPPER_END)
            suffix = content[wrap_full_end:]
            if suffix.startswith("\r\n"):
                suffix = suffix[2:]
            elif suffix.startswith("\n"):
                suffix = suffix[1:]

            if prefix and not prefix.endswith("\n"):
                prefix += "\n"
            if raw_body and suffix:
                if not raw_body.endswith("\n") and not suffix.startswith("\n"):
                    raw_body += "\n"
            res = prefix + raw_body + suffix
            if res and not res.endswith("\n"):
                res += "\n"
            return res

    # Fallback to regex for legacy wrapper format without explicit body markers
    wrapper_regex = re.compile(
        r"# --- Triad Execution Wrapper \[START\] ---\n.*?\(\n(?::\n)?(.*?)\n\)\nUSER_EXIT=\$\?\n.*?\n# --- Triad Execution Wrapper \[END\] ---\n?",
        flags=re.DOTALL
    )
    res = wrapper_regex.sub(r"\1\n", content)
    if res and not res.endswith("\n"):
        res += "\n"
    return res


def _integrate_triad_into_hook(content: str, triad_block: str) -> str:
    """
    Integrates Triad gate into an existing shell hook script.
    Child-process contract:
    - User hook body executes in an isolated subshell preserving its exit status without trap interference.
    - User hook retains complete ownership of trap state (trap -p is untouched; custom EXIT traps run cleanly).
    - If the user hook calls exec, the child process exits cleanly and returns exit code to USER_EXIT.
    - If the user hook needs to export environment variables to Triad stages, it can write exports to $TRIAD_ENV_FILE.
    - If USER_EXIT != 0, exits immediately with USER_EXIT without running Triad.
    - Otherwise, execution flows seamlessly into Triad.
    Preserves exact user body bytes and boundary whitespace without stripping.
    """
    import re
    # 1. Strip any existing Triad pre-commit block
    cleaned = re.sub(
        r"\n?# --- # Triad Autonomous Pre-Commit Gate Hook \[START\] ---.*?# --- # Triad Autonomous Pre-Commit Gate Hook \[END\] ---\n?",
        "",
        content,
        flags=re.DOTALL
    )

    # 2. Strip any existing user wrapper if previously installed (idempotency)
    cleaned = _unwrap_triad_user_body(cleaned)

    lines = cleaned.splitlines(keepends=True)
    if not lines or not "".join(lines).strip():
        return triad_block.strip() + "\n"

    shebang = ""
    user_body = cleaned
    had_blank_after_shebang = False
    if lines[0].startswith("#!"):
        shebang = lines[0].rstrip("\r\n")
        remaining = "".join(lines[1:])
        if remaining.startswith("\r\n"):
            had_blank_after_shebang = True
            user_body = remaining[2:]
        elif remaining.startswith("\n"):
            had_blank_after_shebang = True
            user_body = remaining[1:]
        else:
            user_body = remaining

    # Remove only the trailing line terminator from user_body for the subshell syntax, preserving boundary whitespace
    if user_body.endswith("\r\n"):
        user_body_clean = user_body[:-2]
    elif user_body.endswith("\n"):
        user_body_clean = user_body[:-1]
    else:
        user_body_clean = user_body

    if not user_body_clean.strip():
        if shebang:
            shebang_sep = "\n\n" if had_blank_after_shebang else "\n"
            return f"{shebang}{shebang_sep}{triad_block.strip()}\n"
        return f"{triad_block.strip()}\n"

    wrapped_block = (
        f"{TRIAD_USER_WRAPPER_START}\n"
        f'TRIAD_ENV_FILE=$(mktemp "${{TMPDIR:-/tmp}}/triad_env.XXXXXX" 2>/dev/null || true)\n'
        f'if [ -n "$TRIAD_ENV_FILE" ] && [ -f "$TRIAD_ENV_FILE" ]; then\n'
        f"    export TRIAD_ENV_FILE\n"
        f"else\n"
        f'    TRIAD_ENV_FILE=""\n'
        f"fi\n"
        f"(\n"
        f":\n"
        f"{TRIAD_USER_BODY_START}\n"
        f"{user_body_clean}\n"
        f"{TRIAD_USER_BODY_END}\n"
        f")\n"
        f"USER_EXIT=$?\n"
        f'if [ -n "$TRIAD_ENV_FILE" ] && [ -f "$TRIAD_ENV_FILE" ]; then\n'
        f"    set -a\n"
        f'    . "$TRIAD_ENV_FILE" 2>/dev/null || true\n'
        f"    set +a\n"
        f'    rm -f "$TRIAD_ENV_FILE"\n'
        f"fi\n"
        f"if [ $USER_EXIT -ne 0 ]; then\n"
        f"    exit $USER_EXIT\n"
        f"fi\n"
        f"{TRIAD_USER_WRAPPER_END}"
    )

    if shebang:
        shebang_sep = "\n\n" if had_blank_after_shebang else "\n"
        return f"{shebang}{shebang_sep}{wrapped_block}\n\n{triad_block.strip()}\n"
    return f"{wrapped_block}\n\n{triad_block.strip()}\n"


_integrate_triad_into_husky = _integrate_triad_into_hook


def _is_standalone_triad_hook(content: str) -> bool:
    """Return True if content represents an unintegrated standalone Triad hook template."""
    return (
        TRIAD_HOOK_SIGNATURE in content
        and ("Automatically verifies type safety, test suites" in content or "pre-commit.legacy" in content)
        and TRIAD_USER_WRAPPER_START not in content
    )


def _is_integrated_triad_hook(content: str) -> bool:
    """Return True if content represents an integrated Triad hook inside a user script."""
    return (
        TRIAD_HOOK_SIGNATURE in content
        and (
            TRIAD_USER_WRAPPER_START in content
            or "# --- # Triad Autonomous Pre-Commit Gate Hook [START] ---" in content
            or "USER_EXIT=$?" in content
        )
    )


def _is_hook_executable(mode: Optional[int], is_husky: bool = False) -> bool:
    """Check whether a hook's file mode is executable according to OS semantics."""
    if is_husky:
        return True
    if mode is None:
        return True
    if os.name != "nt":
        return (mode & 0o111) != 0
    return True


class _HookLock:
    """Exclusive cooperative lock using OS-level locking to serialize Triad hook mutations."""
    def __init__(self, hooks_dir: Path, timeout: float = 10.0):
        self.lock_file = hooks_dir / ".triad_hook.lock"
        self.timeout = timeout
        self.fd = None

    def __enter__(self):
        self.lock_file.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        self.fd = os.open(str(self.lock_file), flags, 0o600)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(self.fd, 0, os.SEEK_SET)
                    msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except (OSError, IOError):
                if time.monotonic() >= deadline:
                    try:
                        os.close(self.fd)
                    except Exception:
                        pass
                    self.fd = None
                    raise TimeoutError(f"Timed out acquiring exclusive hook lock on {self.lock_file}")
                time.sleep(0.05)

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.fd is not None:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(self.fd, 0, os.SEEK_SET)
                    msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.fd, fcntl.LOCK_UN)
            except Exception:
                pass
            try:
                os.close(self.fd)
            except Exception:
                pass
            self.fd = None


def _verify_destination_unmodified(
    hook_file: Path,
    initial_exists: bool,
    initial_is_symlink: bool,
    initial_target: Optional[str],
    initial_bytes: bytes
) -> None:
    """Verify that destination hook file was not modified concurrently during the operation."""
    current_exists = hook_file.is_symlink() or hook_file.exists()
    if current_exists != initial_exists:
        raise RuntimeError(f"Concurrent modification detected on {hook_file}: existence changed during operation.")
    if not initial_exists:
        return
    current_is_symlink = hook_file.is_symlink()
    if current_is_symlink != initial_is_symlink:
        raise RuntimeError(f"Concurrent modification detected on {hook_file}: symlink state changed during operation.")
    if initial_is_symlink:
        current_target = os.readlink(str(hook_file))
        if current_target != initial_target:
            raise RuntimeError(f"Concurrent modification detected on {hook_file}: symlink target changed during operation.")
    else:
        current_bytes = hook_file.read_bytes()
        if current_bytes != initial_bytes:
            raise RuntimeError(f"Concurrent modification detected on {hook_file}: content modified by concurrent process.")


def _allocate_exclusive_backup(
    hooks_dir: Path,
    is_symlink: bool,
    source_hook: Path,
    cleaned_content: Optional[str] = None,
    orig_mode: Optional[int] = None
) -> Path:
    """
    Exclusively allocate and create a backup artifact so concurrent operations never allocate the same backup name.
    """
    base_name = "pre-commit.legacy"
    idx = 0
    while True:
        candidate_name = base_name if idx == 0 else f"{base_name}.{idx}"
        candidate = hooks_dir / candidate_name
        idx += 1
        if is_symlink:
            try:
                link_target = os.readlink(str(source_hook))
                if candidate.parent != source_hook.parent and not os.path.isabs(link_target):
                    abs_target = (source_hook.parent / link_target).resolve()
                    try:
                        backup_target = os.path.relpath(str(abs_target), str(candidate.parent))
                    except Exception:
                        backup_target = str(abs_target)
                else:
                    backup_target = link_target
                os.symlink(backup_target, str(candidate))
                sidecar = candidate.parent / f"{candidate.name}.triad_link_target"
                try:
                    sidecar.write_text(link_target, encoding="utf-8")
                except Exception:
                    pass
                return candidate
            except FileExistsError:
                continue
            except OSError:
                pass
        try:
            fd = os.open(str(candidate), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            continue
        try:
            with os.fdopen(fd, "wb") as f:
                if cleaned_content is not None:
                    f.write(cleaned_content.encode("utf-8"))
                else:
                    with open(str(source_hook), "rb") as sf:
                        shutil.copyfileobj(sf, f)
            if orig_mode is not None:
                try:
                    candidate.chmod(orig_mode)
                except Exception:
                    pass
            return candidate
        except Exception:
            candidate.unlink(missing_ok=True)
            raise


def cmd_hook(args):
    """
    Manage Git hooks for autonomous pre-commit enforcement.
    Hook Contract & Bounded Execution Model:
    - User hook body in in-place integration runs in an isolated subshell preserving its exit code and traps.
    - Sourced hooks or hooks containing top-level 'return' statements cannot be wrapped inside subshells
      without altering return semantics; these are routed directly to .legacy chaining.
    - Each Triad installation owns exactly one backup artifact tagged via '# TRIAD_BACKUP_OWNED: <name>'.
    - On uninstall, Triad manages and restores ONLY its specifically tagged backup artifact, never touching
      unrelated historical backups.
    """
    action = getattr(args, "hook_action", None) or "status"
    try:
        repo_root = get_repo_root(".")
    except Exception as e:
        print(f"[Triad Hook Error] Not inside a git repository: {e}", file=sys.stderr)
        sys.exit(1)

    hook_file = resolve_target_hook_file(repo_root)
    hooks_dir = hook_file.parent

    common_git_dir = get_git_common_dir(repo_root)

    try:
        is_hooks_dir_in_git = bool(hooks_dir.resolve().relative_to(common_git_dir.resolve()))
    except (ValueError, RuntimeError):
        is_hooks_dir_in_git = (hooks_dir.resolve() == common_git_dir.resolve())

    admin_dir = hooks_dir if is_hooks_dir_in_git else (common_git_dir / "hooks")
    admin_dir.mkdir(parents=True, exist_ok=True)
    backup_dir = hooks_dir if is_hooks_dir_in_git else admin_dir

    if action == "install":
        hooks_dir.mkdir(parents=True, exist_ok=True)
        with _HookLock(admin_dir):
            is_hook_existing = hook_file.is_symlink() or hook_file.exists()
            content = ""
            orig_mode = None
            orig_bytes = b""
            initial_target = None
            if is_hook_existing:
                try:
                    orig_mode = hook_file.stat().st_mode
                except Exception:
                    pass
                if hook_file.is_symlink():
                    try:
                        initial_target = os.readlink(str(hook_file))
                    except Exception:
                        pass
                try:
                    orig_bytes = hook_file.read_bytes()
                    content = orig_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    content = ""
                except Exception as e:
                    print(f"❌ [Triad Hook Error] Failed reading existing hook {hook_file}: {e}", file=sys.stderr)
                    sys.exit(1)

            initial_exists = is_hook_existing
            initial_is_symlink = hook_file.is_symlink()

            is_standalone = _is_standalone_triad_hook(content)
            is_integrated = _is_integrated_triad_hook(content)
            is_triad_hook = is_standalone or is_integrated or (TRIAD_HOOK_SIGNATURE in content)

            if not is_hook_existing:
                temp_hook = hooks_dir / f".pre-commit.tmp.{uuid.uuid4().hex[:8]}"
                try:
                    temp_hook.write_bytes(_render_hook_template("none").encode("utf-8"))
                    try:
                        temp_hook.chmod(0o755)
                    except Exception:
                        pass
                    if os.name != "nt" and not os.access(temp_hook, os.X_OK):
                        raise RuntimeError("Executable permission verification failed on hook file.")
                    _verify_destination_unmodified(hook_file, initial_exists, initial_is_symlink, initial_target, orig_bytes)
                    os.replace(str(temp_hook), str(hook_file))
                    print(f"✓ Triad pre-commit hook installed successfully at {hook_file}")
                    return
                except Exception as e:
                    if temp_hook.exists():
                        try:
                            temp_hook.unlink()
                        except Exception:
                            pass
                    print(f"❌ [Triad Hook Error] Failed to install pre-commit hook: {e}", file=sys.stderr)
                    sys.exit(1)

            if is_triad_hook and not getattr(args, "force", False):
                print(f"✓ Triad pre-commit hook is already installed at {hook_file}")
                return

            first_line = content.splitlines()[0] if content.splitlines() else ""
            has_shebang = first_line.startswith("#!")
            is_posix_shell = is_posix_shell_shebang(first_line)
            is_symlink = hook_file.is_symlink()
            is_husky = not is_symlink and ("husky" in content.lower() or ".husky" in str(hook_file))
            is_shebang_free_husky = is_husky and not has_shebang
            is_shell_compatible = is_posix_shell or is_shebang_free_husky
            is_pre_commit_framework = (
                "file generated by pre-commit" in content.lower()
                or "https://pre-commit.com" in content.lower()
                or "pre-commit.com" in content.lower()
            )

            # Standalone hook on --force: Re-install template directly without wrapping it
            if is_standalone and getattr(args, "force", False):
                m_own = re.search(r"# TRIAD_BACKUP_OWNED:\s*([^\s\r\n]+)", content)
                backup_name = m_own.group(1).strip() if m_own else "none"
                m_act = re.search(r"# TRIAD_BACKUP_ACTIVE:\s*([01])", content)
                backup_active = (m_act.group(1).strip() == "1") if m_act else True
                temp_hook = hooks_dir / f".pre-commit.tmp.{uuid.uuid4().hex[:8]}"
                try:
                    temp_hook.write_bytes(_render_hook_template(backup_name, should_execute_backup=backup_active).encode("utf-8"))
                    mode_to_set = (orig_mode | 0o755) if orig_mode is not None else 0o755
                    try:
                        temp_hook.chmod(mode_to_set)
                    except Exception as e:
                        if os.name != "nt":
                            raise RuntimeError(f"Failed to set executable permissions on hook: {e}")

                    if os.name != "nt" and not os.access(temp_hook, os.X_OK):
                        raise RuntimeError("Executable permission verification failed on hook file.")

                    _verify_destination_unmodified(hook_file, initial_exists, initial_is_symlink, initial_target, orig_bytes)
                    os.replace(str(temp_hook), str(hook_file))
                    print(f"✓ Triad pre-commit hook installed successfully at {hook_file}")
                    return
                except Exception as e:
                    if temp_hook.exists():
                        try:
                            temp_hook.unlink()
                        except Exception:
                            pass
                    print(f"❌ [Triad Hook Error] Failed to install pre-commit hook: {e}", file=sys.stderr)
                    sys.exit(1)

            is_executable = _is_hook_executable(orig_mode, is_husky=is_husky)

            # In-place integration strictly for compatible shell scripts without top-level return:
            # Sourced hooks or hooks containing top-level return statements cannot be wrapped inside
            # subshells without altering return semantics; these are routed directly to .legacy chaining.
            has_top_level_return = _has_top_level_return(content)
            can_execute = is_executable or is_husky
            if not is_symlink and not is_pre_commit_framework and is_shell_compatible and can_execute and not has_top_level_return:
                backup_name = "none"
                if not is_triad_hook:
                    try:
                        backup_candidate = _allocate_exclusive_backup(
                            backup_dir,
                            is_symlink=hook_file.is_symlink(),
                            source_hook=hook_file,
                            orig_mode=orig_mode
                        )
                        backup_name = backup_candidate.name
                        print(f"[Triad Hook] Existing third-party pre-commit hook backed up to {backup_candidate} and chained.")
                    except Exception as e:
                        print(f"❌ [Triad Hook Error] Failed backing up hook before in-place modification: {e}", file=sys.stderr)
                        sys.exit(1)
                else:
                    m_own = re.search(r"# TRIAD_BACKUP_OWNED:\s*([^\s\r\n]+)", content)
                    backup_name = m_own.group(1).strip() if m_own else "none"

                temp_hook = hooks_dir / f".pre-commit.tmp.{uuid.uuid4().hex[:8]}"
                try:
                    new_content = _integrate_triad_into_hook(content, _render_triad_hook_block(backup_name))
                    temp_hook.write_bytes(new_content.encode("utf-8"))
                    try:
                        mode_to_set = (orig_mode | 0o755) if orig_mode is not None else 0o755
                        temp_hook.chmod(mode_to_set)
                    except Exception:
                        pass
                    _verify_destination_unmodified(hook_file, initial_exists, initial_is_symlink, initial_target, orig_bytes)
                    os.replace(str(temp_hook), str(hook_file))
                    desc = "integrated with Husky" if is_husky else "integrated in-place"
                    print(f"✓ Triad pre-commit hook installed successfully ({desc} at {hook_file})")
                    return
                except Exception as e:
                    if temp_hook.exists():
                        try:
                            temp_hook.unlink()
                        except Exception:
                            pass
                    print(f"❌ [Triad Hook Error] Failed to install pre-commit hook: {e}", file=sys.stderr)
                    sys.exit(1)

            # Backup existing third-party hook if present and not owned by Triad
            backup_name = "none"
            if is_hook_existing and not is_triad_hook:
                if getattr(args, "force", False):
                    print("[Triad Hook] Overwriting existing hook without backup (--force specified).")
                    backup_name = "none"
                else:
                    try:
                        cleaned_body = _unwrap_triad_user_body(content) if (content and TRIAD_USER_WRAPPER_START in content) else None
                        backup_candidate = _allocate_exclusive_backup(
                            backup_dir,
                            is_symlink=hook_file.is_symlink(),
                            source_hook=hook_file,
                            cleaned_content=cleaned_body if (cleaned_body is not None and cleaned_body != content) else None,
                            orig_mode=orig_mode
                        )
                        backup_name = backup_candidate.name
                        print(f"[Triad Hook] Existing third-party pre-commit hook backed up to {backup_candidate} and chained.")
                    except Exception as e:
                        print(f"❌ [Triad Hook Error] Failed backing up hook before replacement: {e}", file=sys.stderr)
                        sys.exit(1)
            else:
                m_own = re.search(r"# TRIAD_BACKUP_OWNED:\s*([^\s\r\n]+)", content)
                backup_name = m_own.group(1).strip() if m_own else "none"

            # Install TRIAD_HOOK_TEMPLATE
            should_execute_backup = True
            if is_hook_existing and not is_triad_hook:
                should_execute_backup = _is_hook_executable(orig_mode, is_husky=is_husky)
            elif is_triad_hook:
                m_act = re.search(r"# TRIAD_BACKUP_ACTIVE:\s*([01])", content)
                if m_act:
                    should_execute_backup = (m_act.group(1).strip() == "1")

            temp_hook = hooks_dir / f".pre-commit.tmp.{uuid.uuid4().hex[:8]}"
            try:
                temp_hook.write_bytes(_render_hook_template(backup_name, should_execute_backup=should_execute_backup).encode("utf-8"))
                try:
                    mode_to_set = (orig_mode | 0o755) if orig_mode is not None else 0o755
                    temp_hook.chmod(mode_to_set)
                except Exception as e:
                    if os.name != "nt":
                        raise RuntimeError(f"Failed to set executable permissions on hook: {e}")

                if os.name != "nt" and not os.access(temp_hook, os.X_OK):
                    raise RuntimeError("Executable permission verification failed on hook file.")

                _verify_destination_unmodified(hook_file, initial_exists, initial_is_symlink, initial_target, orig_bytes)
                os.replace(str(temp_hook), str(hook_file))
                desc = "integrated with pre-commit framework" if is_pre_commit_framework else "installed successfully"
                print(f"✓ Triad pre-commit hook {desc} at {hook_file}")
            except Exception as e:
                if temp_hook.exists():
                    try:
                        temp_hook.unlink()
                    except Exception:
                        pass
                print(f"❌ [Triad Hook Error] Failed to install pre-commit hook: {e}", file=sys.stderr)
                sys.exit(1)

    elif action == "uninstall":
        with _HookLock(admin_dir):
            is_hook_existing = hook_file.is_symlink() or hook_file.exists()
            if not is_hook_existing:
                print(f"[Triad Hook] No pre-commit hook found at {hook_file}")
                return
            orig_mode = None
            try:
                orig_mode = hook_file.stat().st_mode
            except Exception:
                pass
            content = ""
            orig_bytes = b""
            initial_target = None
            if hook_file.is_symlink():
                try:
                    initial_target = os.readlink(str(hook_file))
                except Exception:
                    pass
            try:
                orig_bytes = hook_file.read_bytes()
                content = orig_bytes.decode("utf-8")
            except UnicodeDecodeError:
                content = orig_bytes.decode("utf-8", errors="replace")
            except Exception:
                pass

            initial_exists = is_hook_existing
            initial_is_symlink = hook_file.is_symlink()

            if TRIAD_HOOK_SIGNATURE not in content:
                if not getattr(args, "force", False):
                    print("[Triad Hook Warning] Existing pre-commit hook was not created by Triad. Use --force to remove.", file=sys.stderr)
                    sys.exit(1)
                # Force removal of an unsigned third-party hook without touching any historical backups
                try:
                    _verify_destination_unmodified(hook_file, initial_exists, initial_is_symlink, initial_target, orig_bytes)
                    hook_file.unlink(missing_ok=True)
                except Exception as e:
                    print(f"❌ [Triad Hook Error] Failed to remove pre-commit hook: {e}", file=sys.stderr)
                    sys.exit(1)
                print(f"✓ Removed third-party pre-commit hook from {hook_file}")
                return

            is_husky = ".husky" in str(hook_file) or (TRIAD_USER_WRAPPER_START in content and "husky" in content.lower())

            m_own = re.search(r"# TRIAD_BACKUP_OWNED:\s*([^\s\r\n]+)", content)
            owned_backup_name = m_own.group(1).strip() if m_own else None

            pattern = re.compile(
                r"\n?# --- # Triad Autonomous Pre-Commit Gate Hook \[START\] ---.*?# --- # Triad Autonomous Pre-Commit Gate Hook \[END\] ---\n?",
                re.DOTALL
            )
            cleaned = pattern.sub("", content)
            cleaned = _unwrap_triad_user_body(cleaned)

            def _legacy_sort_key(p: Path):
                suffix = p.name[len("pre-commit.legacy"):].lstrip(".")
                return int(suffix) if suffix.isdigit() else (0 if not suffix else 999999)
            legacy_backups = sorted([p for p in hooks_dir.glob("pre-commit.legacy*") if (p.is_symlink() or p.exists()) and not p.name.endswith(".triad_link_target")], key=_legacy_sort_key)
            if not is_hooks_dir_in_git:
                legacy_backups = sorted(
                    legacy_backups + [p for p in admin_dir.glob("pre-commit.legacy*") if (p.is_symlink() or p.exists()) and not p.name.endswith(".triad_link_target")],
                    key=_legacy_sort_key
                )
            valid_backups = list(legacy_backups)

            def _find_link_target_sidecar(target_b: Path) -> Optional[Path]:
                for sc in (target_b.parent / f"{target_b.name}.triad_link_target",
                           target_b.parent / f".{target_b.name}.triad_link_target"):
                    if sc.exists():
                        return sc
                return None

            def _restore_backup_file(target_b: Path, dest_hook: Path, is_b_symlink: bool, b_mode: Optional[int]) -> None:
                sidecar = _find_link_target_sidecar(target_b)
                if sidecar and (is_b_symlink or target_b.is_symlink()):
                    orig_link = sidecar.read_text(encoding="utf-8")
                    tmp_symlink = dest_hook.parent / f".tmp_hook_restore_{uuid.uuid4().hex[:8]}"
                    try:
                        os.symlink(orig_link, str(tmp_symlink))
                        os.replace(str(tmp_symlink), str(dest_hook))
                        target_b.unlink(missing_ok=True)
                        sidecar.unlink(missing_ok=True)
                    except Exception:
                        if tmp_symlink.is_symlink() or tmp_symlink.exists():
                            tmp_symlink.unlink(missing_ok=True)
                        raise
                elif is_b_symlink or target_b.is_symlink():
                    orig_link = os.readlink(str(target_b))
                    tmp_symlink = dest_hook.parent / f".tmp_hook_restore_{uuid.uuid4().hex[:8]}"
                    try:
                        os.symlink(orig_link, str(tmp_symlink))
                        os.replace(str(tmp_symlink), str(dest_hook))
                        target_b.unlink(missing_ok=True)
                    except Exception:
                        if tmp_symlink.is_symlink() or tmp_symlink.exists():
                            tmp_symlink.unlink(missing_ok=True)
                        raise
                else:
                    os.replace(str(target_b), str(dest_hook))
                    if not is_b_symlink and b_mode is not None:
                        try:
                            dest_hook.chmod(b_mode)
                        except Exception:
                            pass
                    if sidecar and sidecar.exists():
                        sidecar.unlink(missing_ok=True)

            target_backup = None
            if owned_backup_name is not None:
                if owned_backup_name != "none":
                    if not re.fullmatch(r"pre-commit\.legacy(?:\.[1-9][0-9]*)?", owned_backup_name):
                        raise RuntimeError(f"Invalid Triad backup ownership marker: {owned_backup_name}")
                    candidate = hooks_dir / owned_backup_name
                    if not (candidate.is_symlink() or candidate.exists()) and not is_hooks_dir_in_git:
                        candidate_admin = admin_dir / owned_backup_name
                        if candidate_admin.is_symlink() or candidate_admin.exists():
                            candidate = candidate_admin
                    try:
                        expected_parent = hooks_dir.resolve() if candidate.parent.resolve() == hooks_dir.resolve() else admin_dir.resolve()
                        if candidate.parent.resolve() != expected_parent:
                            raise RuntimeError("Triad backup marker escapes hooks directory")
                    except RuntimeError:
                        raise
                    except Exception:
                        pass
                    if candidate.is_symlink() or candidate.exists():
                        target_backup = candidate
            else:
                # Fallback ONLY for demonstrably older Triad installations (containing TRIAD_HOOK_SIGNATURE) without an ownership marker.
                # Third-party hooks uninstalled with --force must NEVER select or restore an untagged historical backup.
                if TRIAD_HOOK_SIGNATURE in content and valid_backups:
                    target_backup = valid_backups[-1]
                else:
                    target_backup = None

            # An integrated hook contains Triad's wrapper around user hook content
            is_integrated = (TRIAD_USER_WRAPPER_START in content) or (
                not _is_standalone_triad_hook(content)
                and cleaned.strip()
                and not cleaned.replace("\r\n", "\n").startswith("#!/bin/sh\n# Triad")
            )

            force_restore = getattr(args, "force", False)

            if is_integrated:
                # Check if extracted user body or cleaned content matches target backup
                backup_matches = False
                if target_backup:
                    try:
                        b_content = target_backup.read_text(encoding="utf-8", errors="replace")
                        triad_block = _render_triad_hook_block(owned_backup_name or "none")
                        expected_integrated = _integrate_triad_into_hook(b_content, triad_block)
                        norm_content = content.replace("\r\n", "\n").strip()
                        norm_exp = expected_integrated.replace("\r\n", "\n").strip()
                        norm_cleaned = cleaned.replace("\r\n", "\n").strip()
                        norm_b = b_content.replace("\r\n", "\n").strip()
                        if norm_content == norm_exp or norm_cleaned == norm_b:
                            backup_matches = True
                    except Exception:
                        pass

                if (backup_matches or force_restore) and target_backup:
                    try:
                        backup_mode = None
                        try:
                            backup_mode = target_backup.stat().st_mode
                        except Exception:
                            pass
                        is_backup_symlink = target_backup.is_symlink()
                        _verify_destination_unmodified(hook_file, initial_exists, initial_is_symlink, initial_target, orig_bytes)
                        _restore_backup_file(target_backup, hook_file, is_backup_symlink, backup_mode)
                        print(f"[Triad Hook] Restored previous hook from {target_backup}")
                    except Exception as e:
                        print(f"❌ [Triad Hook Error] Failed to restore pre-commit hook: {e}", file=sys.stderr)
                        sys.exit(1)
                else:
                    # Write back the cleaned user hook, preserving all user edits made after installation!
                    temp_hook = hooks_dir / f".pre-commit.tmp.{uuid.uuid4().hex[:8]}"
                    try:
                        cleaned_bytes = cleaned.encode("utf-8")
                        if not cleaned_bytes.endswith(b"\n"):
                            cleaned_bytes += b"\n"
                        temp_hook.write_bytes(cleaned_bytes)
                        mode_to_set = orig_mode if orig_mode is not None else 0o755
                        try:
                            temp_hook.chmod(mode_to_set)
                        except Exception:
                            pass
                        _verify_destination_unmodified(hook_file, initial_exists, initial_is_symlink, initial_target, orig_bytes)
                        os.replace(str(temp_hook), str(hook_file))
                        if target_backup:
                            try:
                                target_backup.unlink()
                            except Exception:
                                pass
                            sidecar = _find_link_target_sidecar(target_backup)
                            if sidecar and sidecar.exists():
                                sidecar.unlink(missing_ok=True)
                    except Exception as e:
                        if temp_hook.exists():
                            try:
                                temp_hook.unlink()
                            except Exception:
                                pass
                        print(f"❌ [Triad Hook Error] Failed to clean hook: {e}", file=sys.stderr)
                        sys.exit(1)

                if is_husky:
                    print(f"✓ Triad pre-commit hook uninstalled from Husky hook at {hook_file}")
                else:
                    print(f"✓ Triad pre-commit hook uninstalled from {hook_file}")
                return

            try:
                # Standalone hook edit protection: refuse to delete if user modified hook after install
                m_act = re.search(r"# TRIAD_BACKUP_ACTIVE:\s*([01])", content)
                backup_active = (m_act.group(1).strip() == "1") if m_act else True
                expected_template = _render_hook_template(owned_backup_name or "none", should_execute_backup=backup_active)
                if content.replace("\r\n", "\n").strip() != expected_template.replace("\r\n", "\n").strip():
                    if not force_restore:
                        print(
                            "[Triad Hook Warning] Standalone pre-commit hook contains user modifications made after installation.\n"
                            "Refusing to uninstall without --force to prevent data loss.",
                            file=sys.stderr
                        )
                        sys.exit(1)

                if target_backup:
                    backup_mode = None
                    try:
                        backup_mode = target_backup.stat().st_mode
                    except Exception:
                        pass
                    is_backup_symlink = target_backup.is_symlink()
                    _verify_destination_unmodified(hook_file, initial_exists, initial_is_symlink, initial_target, orig_bytes)
                    _restore_backup_file(target_backup, hook_file, is_backup_symlink, backup_mode)
                    print(f"[Triad Hook] Restored previous hook from {target_backup}")
                else:
                    _verify_destination_unmodified(hook_file, initial_exists, initial_is_symlink, initial_target, orig_bytes)
                    hook_file.unlink(missing_ok=True)
            except Exception as e:
                print(f"❌ [Triad Hook Error] Failed to restore pre-commit hook: {e}", file=sys.stderr)
                sys.exit(1)
            print(f"✓ Triad pre-commit hook uninstalled from {hook_file}")

    elif action == "status":
        is_hook_existing = hook_file.is_symlink() or hook_file.exists()
        if not is_hook_existing:
            print("Triad pre-commit hook: Not installed")
        else:
            content = ""
            try:
                content = hook_file.read_text(encoding="utf-8", errors="replace")
            except Exception:
                pass
            if TRIAD_HOOK_SIGNATURE in content:
                legacy_hooks = [p for p in hook_file.parent.glob("pre-commit.legacy*") if (p.is_symlink() or p.exists()) and not p.name.endswith(".triad_link_target")]
                has_pre_commit_framework_backup = any(
                    ("pre-commit.com" in p.read_text(encoding="utf-8", errors="replace").lower()
                     or "file generated by pre-commit" in p.read_text(encoding="utf-8", errors="replace").lower())
                    for p in legacy_hooks if p.is_file()
                )
                if "husky" in content.lower() or ".husky" in str(hook_file):
                    print(f"Triad pre-commit hook: Installed (integrated with Husky at {hook_file})")
                elif "pre-commit.com" in content.lower() or "file generated by pre-commit" in content.lower() or has_pre_commit_framework_backup:
                    print(f"Triad pre-commit hook: Installed (integrated with pre-commit framework at {hook_file})")
                elif legacy_hooks:
                    print(f"Triad pre-commit hook: Installed (with legacy hook chained at {hook_file})")
                else:
                    print(f"Triad pre-commit hook: Installed ({hook_file})")
            else:
                hook_type = "Custom/Third-party"
                if "husky" in content.lower() or ".husky" in str(hook_file):
                    hook_type = "Husky"
                elif "pre-commit.com" in content.lower() or "file generated by pre-commit" in content.lower():
                    hook_type = "pre-commit framework"
                print(f"Triad pre-commit hook: {hook_type} hook installed ({hook_file})")


def _mesh_list_tools(node_bin: str, server_path: Path, origin: str = "antigravity", timeout: float = 8.0) -> List[Dict[str, Any]]:
    """Probe the Agent Mesh MCP server and retrieve registered tools with timeout and process cleanup."""
    env = dict(os.environ)
    if "AGENT_MESH_ALLOWED_ROOTS" not in env:
        default_roots = f"{Path.home() / 'projects'};{Path.home() / 'Desktop' / 'projects'}"
        env["AGENT_MESH_ALLOWED_ROOTS"] = default_roots

    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "triad", "version": "1.0"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    ]
    payload = "\n".join(json.dumps(m) for m in msgs) + "\n"
    proc = subprocess.Popen(
        [node_bin, str(server_path), "--origin", origin],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    try:
        out, _ = proc.communicate(payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise TimeoutError(f"Agent Mesh probe timed out after {timeout}s")
    except Exception:
        proc.kill()
        proc.communicate()
        raise

    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
            if r.get("id") == 2:
                return r.get("result", {}).get("tools", [])
        except ValueError:
            continue
    raise RuntimeError("No tools/list response received from Agent Mesh")


def cmd_mesh(args=None):
    """
    Agent Mesh MCP coordination, status, and health supervision.
    """
    if isinstance(args, str):
        mesh_action = "status"
        origin = "antigravity"
        as_json = False
    elif args is None:
        mesh_action = "status"
        origin = "antigravity"
        as_json = False
    else:
        mesh_action = getattr(args, "mesh_action", "status") or "status"
        origin = getattr(args, "origin", "antigravity") or "antigravity"
        as_json = bool(getattr(args, "json", False))

    node_bin = shutil.which("node")
    server_path = AGENT_MESH_SERVER
    server_exists = server_path.exists()

    report: Dict[str, Any] = {
        "node_available": bool(node_bin),
        "node_path": node_bin or "",
        "mesh_dir": str(AGENT_MESH_DIR),
        "server_path": str(server_path),
        "server_built": server_exists,
        "origin": origin,
        "status": "ready" if (node_bin and server_exists) else "unready",
    }

    if mesh_action in ("status", "doctor"):
        tools = []
        if node_bin and server_exists:
            try:
                tools = _mesh_list_tools(node_bin, server_path, origin=origin)
                report["tools_count"] = len(tools)
            except Exception as e:
                report["probe_error"] = str(e)
                report["status"] = "degraded"

        config_status = {}
        gemini_cfg = Path.home() / ".gemini" / "config" / "mcp_config.json"
        gemini_antigravity = Path.home() / ".gemini" / "antigravity" / "mcp_config.json"
        claude_cfg = Path.home() / ".claude.json"
        codex_cfg = Path.home() / ".codex" / "config.toml"

        try:
            if gemini_cfg.exists():
                cfg_data = json.loads(gemini_cfg.read_text(encoding="utf-8", errors="replace"))
                config_status["gemini_cli"] = "agent-mesh" in cfg_data.get("mcpServers", {})
            else:
                config_status["gemini_cli"] = False
        except Exception:
            config_status["gemini_cli"] = False

        try:
            if gemini_antigravity.exists():
                cfg_data = json.loads(gemini_antigravity.read_text(encoding="utf-8", errors="replace"))
                config_status["antigravity_ide"] = "agent-mesh" in cfg_data.get("mcpServers", {})
            else:
                config_status["antigravity_ide"] = False
        except Exception:
            config_status["antigravity_ide"] = False

        try:
            if claude_cfg.exists():
                cfg_data = json.loads(claude_cfg.read_text(encoding="utf-8", errors="replace"))
                config_status["claude_code"] = "agent-mesh" in cfg_data.get("mcpServers", {})
            else:
                config_status["claude_code"] = False
        except Exception:
            config_status["claude_code"] = False

        try:
            if codex_cfg.exists():
                codex_text = codex_cfg.read_text(encoding="utf-8", errors="replace")
                config_status["codex"] = "[mcp_servers.agent-mesh]" in codex_text
            else:
                config_status["codex"] = False
        except Exception:
            config_status["codex"] = False

        report["client_registrations"] = config_status

        if as_json:
            print(json.dumps(report, indent=2))
            if mesh_action == "doctor" and report["status"] != "ready":
                sys.exit(1)
            return

        print("\n=== Agent Mesh MCP Subsystem Status ===")
        print(f"  Directory:    {AGENT_MESH_DIR}")
        print(f"  Server:       {server_path} ({'✓ Built' if server_exists else '❌ Not Built'})")
        print(f"  Node.js:      {node_bin or '❌ Missing'}")
        print(f"  Active Tools: {report.get('tools_count', 'N/A')}")
        print("\n  Client Mounts:")
        for client, mounted in config_status.items():
            mark = "✓ Mounted" if mounted else "❌ Not mounted"
            print(f"    - {client:16s}: {mark}")
        print(f"\n  Subsystem Health: {'✅ OPTIMAL' if report['status'] == 'ready' else '❌ DEGRADED'}\n")

        if mesh_action == "doctor" and report["status"] != "ready":
            sys.exit(1)

    elif mesh_action == "tools":
        if not node_bin or not server_exists:
            print("❌ Agent Mesh server not built or Node.js missing.", file=sys.stderr)
            sys.exit(1)
        try:
            tools = _mesh_list_tools(node_bin, server_path, origin=origin)
            if as_json:
                print(json.dumps(tools, indent=2))
            else:
                print(f"\n=== Agent Mesh MCP Registered Tools ({len(tools)}) ===")
                for t in tools:
                    print(f"  - {t['name']:32s} : {t.get('description', '')[:70]}")
                print()
        except Exception as e:
            print(f"❌ Failed to list tools: {e}", file=sys.stderr)
            sys.exit(1)

    elif mesh_action == "serve":
        if not node_bin or not server_exists:
            print("❌ Agent Mesh server not built or Node.js missing.", file=sys.stderr)
            sys.exit(1)
        cmd = [node_bin, str(server_path), "--origin", origin]
        try:
            res = subprocess.run(cmd)
            sys.exit(res.returncode)
        except KeyboardInterrupt:
            sys.exit(0)


def is_plausible_natural_language(first_arg: str, total_args: int, known_commands: set) -> bool:
    """Return True if argument looks like a natural language query or diff rather than a mistyped subcommand."""
    import difflib
    stripped = first_arg.strip()
    if not stripped:
        return False

    # If first_arg is a single word (no spaces inside):
    if " " not in stripped:
        lowered = stripped.lower()
        if lowered not in known_commands:
            near_matches = difflib.get_close_matches(lowered, [c for c in known_commands if not c.startswith("-")], n=1, cutoff=0.75)
            if near_matches:
                return False  # Near-miss typo of a known subcommand (e.g. 'revew', 'gaet', 'docter')

        # If it has path or query punctuation (e.g. 'path/to/file.py' or 'hello?'), allow it
        if any(c in stripped for c in ("?", "\n", "\t", "/", "\\", ":", ".")):
            return True

        # If multiple unquoted arguments were passed (e.g. 'triad why is this failing'), allow it
        if total_args > 2:
            return True

        # Otherwise it's a single bare unknown token like 'foo' -> reject
        return False

    # If first_arg contains spaces (quoted natural language prompt), allow it
    return True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="triad", description="Autonomous Multi-Agent Triad Orchestrator")
    subparsers = parser.add_subparsers(dest="command", help="Triad command to execute")

    # auto / intent / run
    p_auto = subparsers.add_parser("auto", aliases=["intent", "run"], help="Auto-classify intent and autonomously route across Triad subsystems")
    p_auto.add_argument("prompt", nargs="*", default=[], help="Natural language request, diff, or query")
    p_auto.add_argument("--diff-file", default="", help="Path to diff file or - for stdin")
    p_auto.add_argument("--context", default="", help="Inline context or error snippet")
    p_auto.add_argument("--context-file", default="", help="Path to context file")
    p_auto.add_argument("--competition", action="store_true", help="Force competition mode regardless of auto-stake assessment")
    p_auto.add_argument("--adversarial", action="store_true", help="Execute Red/Blue adversarial arena audit")
    p_auto.add_argument("--engine", default="auto", help="Advisor engine override")
    p_auto.add_argument("--cached", "--staged", action="store_true", help="Review staged changes if routing to review")
    p_auto.add_argument("--head", action="store_true", help="Review the most recent commit (HEAD~1..HEAD) if routing to review")
    p_auto.add_argument("--worktree", "-w", action="store_true", help="Execute in an isolated ephemeral git worktree")
    p_auto.add_argument("--ref", default="HEAD", help="Git ref/branch/commit to base ephemeral worktree on (default: HEAD)")
    p_auto.add_argument("--apply-verified", action="store_true", help="Apply passing self-healing patches back to parent working tree")
    p_auto.add_argument("--test-timeout", type=int, default=300, help="Test runner timeout in seconds (default 300)")
    p_auto.add_argument("--target", default="", help="Targeted test pattern (e.g. test_circuit.py)")
    p_auto.add_argument("--targeted", action="store_true", help="Auto-resolve targeted test pattern from changed files")
    p_auto.add_argument("--parallel", action="store_true", help="Execute test suite in parallel using pytest-xdist when available")
    p_auto.add_argument("--classify-only", action="store_true", help="Print the intent classification as JSON and exit without executing")

    # doctor
    p_doc = subparsers.add_parser("doctor", help="Run comprehensive health and billing audit across all platforms (exit 1 if no advisor is usable)")
    p_doc.add_argument("--quick", action="store_true", help="Skip the live Claude probe (saves a Claude Pro turn)")
    p_doc.add_argument("--json", action="store_true", help="Emit the structured report as JSON")
    p_doc.add_argument("--reset-circuits", action="store_true", help="Clear advisor circuit-breaker cooldowns before the audit")

    # review
    p_rev = subparsers.add_parser("review", help="Review a git diff with the Advisory Council")
    p_rev.add_argument("prompt", nargs="?", default="", help="Specific review instructions or feature intent")
    p_rev.add_argument("--diff-file", default="", help="Path to diff file or - for stdin")
    p_rev.add_argument("--cached", "--staged", action="store_true", help="Review staged changes")
    p_rev.add_argument("--head", action="store_true", help="Review the most recent commit (HEAD~1..HEAD)")
    p_rev.add_argument("--engine", default="auto", help="Advisor engine override (e.g. auto, claude, codex, ollama, mock)")
    p_rev.add_argument("--competition", action="store_true", help="Execute Claude Code & OpenAI Codex concurrently with structured synthesis")
    p_rev.add_argument("--adversarial", action="store_true", help="Execute Red/Blue adversarial arena security and resilience audit")

    # consult
    p_con = subparsers.add_parser("consult", help="Consult Advisory Council on architectural design")
    p_con.add_argument("prompt", nargs="?", default="", help="Architectural question or proposal")
    p_con.add_argument("--context", default="", help="Inline context or schema")
    p_con.add_argument("--context-file", default="", help="Path to context file")
    p_con.add_argument("--engine", default="auto", help="Advisor engine override (e.g. auto, claude, codex, ollama, mock)")
    p_con.add_argument("--competition", action="store_true", help="Execute Claude Code & OpenAI Codex concurrently with structured synthesis")
    p_con.add_argument("--adversarial", action="store_true", help="Execute Red/Blue adversarial arena architecture challenge")

    # debug
    p_dbg = subparsers.add_parser("debug", help="Diagnose a stubborn error or bug with Advisory Council")
    p_dbg.add_argument("error", nargs="?", default="", help="Error message or description")
    p_dbg.add_argument("--context", default="", help="Code snippet or context")
    p_dbg.add_argument("--context-file", default="", help="Path to context file")
    p_dbg.add_argument("--engine", default="auto", help="Advisor engine override (e.g. auto, claude, codex, ollama, mock)")
    p_dbg.add_argument("--competition", action="store_true", help="Execute Claude Code & OpenAI Codex concurrently with structured synthesis")
    p_dbg.add_argument("--adversarial", action="store_true", help="Execute Red/Blue adversarial diagnosis")

    # gate
    p_gate = subparsers.add_parser("gate", help="Run full pre-commit verification (tsc + tests + diff review)")
    p_gate.add_argument("--engine", default="auto", help="Advisor engine override (e.g. auto, claude, codex, ollama, mock)")
    p_gate.add_argument("--competition", action="store_true", help="Execute Claude Code & OpenAI Codex concurrently with structured synthesis")
    p_gate.add_argument("--max-retries", type=int, default=1, help="Max self-healing retries for tsc/tests (default 1)")
    p_gate.add_argument("--timeout", type=int, default=240, help="Advisor signoff timeout in seconds (default 240)")
    p_gate.add_argument("--test-timeout", type=int, default=300, help="Test runner timeout in seconds (default 300)")
    p_gate.add_argument("--target", default="", help="Targeted test pattern (e.g. test_circuit.py)")
    p_gate.add_argument("--targeted", action="store_true", help="Auto-resolve targeted test pattern from changed files")
    p_gate.add_argument("--parallel", action="store_true", help="Execute test suite in parallel using pytest-xdist when available")
    p_gate.add_argument("--worktree", "-w", action="store_true", help="Execute pre-commit gate in an isolated ephemeral git worktree")
    p_gate.add_argument("--ref", default="HEAD", help="Git ref/branch/commit to base ephemeral worktree on (default: HEAD)")
    p_gate.add_argument("--apply-verified", action="store_true", help="Apply passing self-healing patches back to parent working tree")

    # bench
    p_bench = subparsers.add_parser("bench", help="Run benchmark harness to score review accuracy against known bugs")
    p_bench.add_argument("--suite", choices=["cases", "swebench"], default="cases", help="Benchmark suite ('cases' or 'swebench')")
    p_bench.add_argument("--cases-dir", default="", help="Path to cases directory (defaults to triad/bench/cases)")
    p_bench.add_argument("--engine", default="auto", help="Advisor engine override (e.g. auto, claude, codex, bare_single, mock)")
    p_bench.add_argument("--judge-engine", choices=["claude", "auto", "codex", "asymmetric"], default="claude", help="Judge engine (default: claude, then Codex if Claude cannot answer)")
    p_bench.add_argument("--docker", choices=["off", "auto", "on"], default="off", help="Repo-native tests in Docker when a local clone exists (default: off)")
    p_bench.add_argument("--workers", type=int, choices=[1, 2], default=2, help="Number of concurrent evaluation workers (1 or 2, default: 2)")
    p_bench.add_argument("--limit", type=int, default=0, help="Limit number of cases to test")
    p_bench.add_argument("--case", default="", help="Run single case ID (e.g. case_001 or astropy__astropy-12907)")
    p_bench.add_argument("--verbose", "-v", action="store_true", help="Print verbose review output")

    # worktree
    p_wt = subparsers.add_parser("worktree", help="Manage ephemeral git worktrees (create, remove, list, prune)")
    wt_sub = p_wt.add_subparsers(dest="wt_action", help="Worktree action")
    wt_sub.add_parser("list", help="List all active worktrees")
    p_wt_create = wt_sub.add_parser("create", help="Create a new isolated worktree")
    p_wt_create.add_argument("--ref", default="HEAD", help="Commit, branch, or tag (default HEAD)")
    p_wt_create.add_argument("--prefix", default="triad-work", help="Directory prefix")
    p_wt_remove = wt_sub.add_parser("remove", help="Remove an isolated worktree")
    p_wt_remove.add_argument("path", help="Path to worktree directory to remove")
    p_wt_remove.add_argument("--force", "-f", action="store_true", default=False, help="Force removal, including uncommitted changes")
    wt_sub.add_parser("prune", help="Prune orphaned worktree metadata")

    # hook
    p_hook = subparsers.add_parser("hook", help="Manage git hooks (install, uninstall, status)")
    hook_sub = p_hook.add_subparsers(dest="hook_action", help="Hook action")
    p_hook_install = hook_sub.add_parser("install", help="Install Triad pre-commit gate hook")
    p_hook_install.add_argument("--force", "-f", action="store_true", help="Force overwrite existing hook without backup")
    p_hook_uninstall = hook_sub.add_parser("uninstall", help="Uninstall Triad pre-commit gate hook")
    p_hook_uninstall.add_argument("--force", "-f", action="store_true", help="Force removal even if hook was modified")
    hook_sub.add_parser("status", help="Check pre-commit hook installation status")

    # listen / serve
    p_listen = subparsers.add_parser("listen", aliases=["serve"], help="Start Triad Ambient HTTP server daemon")
    p_listen.add_argument("--port", type=int, default=8789, help="HTTP daemon port (default 8789)")
    p_listen.add_argument("--host", default="127.0.0.1", help="HTTP daemon host (default 127.0.0.1)")

    # mesh / swarm
    p_mesh = subparsers.add_parser("mesh", aliases=["swarm"], help="Agent Mesh MCP coordination, status, and health supervision")
    p_mesh.add_argument("mesh_action", nargs="?", default="status", choices=["status", "doctor", "tools", "serve"], help="Mesh action (status, doctor, tools, serve)")
    p_mesh.add_argument("--origin", default="antigravity", help="Origin identity (antigravity, claude, codex, cursor, grok)")
    p_mesh.add_argument("--json", action="store_true", help="Output results in JSON format")

    return parser


def main():
    # Top-level intuitive auto-dispatch: if first arg is not a known command or flag and looks like natural language, route through auto
    known_commands = {
        "doctor", "review", "consult", "debug", "gate",
        "bench", "worktree", "auto", "intent", "run",
        "listen", "serve", "hook", "mesh", "swarm",
        "-h", "--help"
    }
    if len(sys.argv) > 1 and sys.argv[1] not in known_commands and not sys.argv[1].startswith("-"):
        if is_plausible_natural_language(sys.argv[1], len(sys.argv), known_commands):
            sys.argv.insert(1, "auto")

    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    dispatch = {
        "auto": cmd_auto,
        "intent": cmd_auto,
        "run": cmd_auto,
        "doctor": cmd_doctor,
        "review": cmd_review,
        "consult": cmd_consult,
        "debug": cmd_debug,
        "gate": cmd_gate,
        "bench": cmd_bench,
        "worktree": cmd_worktree,
        "hook": cmd_hook,
        "listen": cmd_listen,
        "serve": cmd_listen,
        "mesh": cmd_mesh,
        "swarm": cmd_mesh,
    }

    handler = dispatch.get(args.command)
    if handler:
        handler(args)

if __name__ == "__main__":
    main()
