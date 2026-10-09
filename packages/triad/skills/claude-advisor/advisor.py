"""
Claude & OpenAI Codex Multi-Advisor Bridge for Antigravity & Agent Triad (Hardened v3).
Autonomous non-interactive advisory queries with:
- Automatic Failover: Claude Code -> OpenAI Codex (gpt-6-astra) on session/rate limit
- Stdin piping (bypasses Windows 32,767 char lpCommandLine limit)
- Pure advisory mode (--tools= on Claude, -s read-only on Codex) to prevent rogue tool spawns
- Strict UTF-8 stream reconfiguration (guards against Windows cp1252 crash)
- Ephemeral, zero-bloat execution (--ignore-user-config, --ephemeral)
- Recursive process-tree cleanup on timeout (kills child node.exe/codex processes)
"""

import sys
import subprocess
import argparse
import os
import shutil
import tempfile
from pathlib import Path

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

_HOME = Path.home()
_LOCAL_APPDATA = Path(os.environ.get("LOCALAPPDATA", str(_HOME / "AppData" / "Local")))

# Places the triad package may live relative to this skill (repo checkout or ~/.agents install)
_TRIAD_CANDIDATE_ROOTS = [
    Path(__file__).resolve().parents[2],          # <repo>/skills/claude-advisor -> <repo>
    _HOME / ".agents",                             # ~/.agents/triad/*.py  (installed flat copy)
    _HOME / "projects" / "autonomous-triad",
]
_TRIAD_IMPORT_ATTEMPTED = False
_TRIAD_ADVISOR_MANAGER = None
_TRIAD_COMPETITION = None


def _import_triad():
    """Best-effort import of the shared Triad engine so this skill does not drift from it."""
    global _TRIAD_IMPORT_ATTEMPTED, _TRIAD_ADVISOR_MANAGER, _TRIAD_COMPETITION
    if _TRIAD_IMPORT_ATTEMPTED:
        return _TRIAD_ADVISOR_MANAGER, _TRIAD_COMPETITION
    _TRIAD_IMPORT_ATTEMPTED = True
    env_root = os.environ.get("TRIAD_ROOT", "").strip()
    roots = ([Path(os.path.expanduser(env_root))] if env_root else []) + _TRIAD_CANDIDATE_ROOTS
    for root in roots:
        if root.exists() and str(root) not in sys.path:
            sys.path.append(str(root))
    # Also ensure flat installed path is available for direct imports
    flat_triad = _HOME / ".agents" / "triad"
    if flat_triad.exists() and str(flat_triad) not in sys.path:
        sys.path.append(str(flat_triad))
    try:
        from triad import advisor_manager as am  # type: ignore
        from triad import competition as comp    # type: ignore
        _TRIAD_ADVISOR_MANAGER, _TRIAD_COMPETITION = am, comp
    except Exception as exc1:
        try:
            import advisor_manager as am  # type: ignore
            import competition as comp    # type: ignore
            _TRIAD_ADVISOR_MANAGER, _TRIAD_COMPETITION = am, comp
        except Exception as exc2:
            print(f"[Advisor Warning] Could not import triad engine ({exc1}; {exc2}); falling back to standalone advisor path.", file=sys.stderr)
    return _TRIAD_ADVISOR_MANAGER, _TRIAD_COMPETITION


def _resolve(cmd: str, *defaults: Path) -> str:
    """Resolve a CLI binary: PATH first, then conventional per-user locations."""
    which = shutil.which(cmd)
    if which:
        return which
    for d in defaults:
        if d.exists():
            return str(d)
    return cmd


def kill_process_tree(pid: int):
    """Force kill a process and all its descendants (delegates to triad.procutil when available)."""
    am, _ = _import_triad()
    if am is not None:
        try:
            am.kill_process_tree(pid)
            return
        except Exception:
            pass
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        else:
            import signal
            os.kill(pid, signal.SIGKILL)
    except Exception:
        pass

def build_prompt(prompt: str, context: str = None, diff: str = None, mode: str = "general") -> str:
    system_preamble = (
        "You are the Lead Architect and Code Reviewer acting as an autonomous advisor to Antigravity (the primary coding agent).\n"
        "Antigravity has already handled the broad workspace and heavy context ingestion.\n"
        "You are strictly in Advisory mode. Provide direct, high-density analysis, exact code snippets, or architectural flags.\n"
    )

    if mode == "review_diff":
        return (
            f"{system_preamble}\n"
            "TASK: Review this git diff for subtle bugs, race conditions, edge cases, type soundness, and architectural regressions.\n\n"
            f"DIFF:\n```\n{diff or context or ''}\n```\n\n"
            f"ADDITIONAL CONTEXT / GOAL:\n{prompt}\n"
        )
    elif mode == "architect":
        return (
            f"{system_preamble}\n"
            "TASK: Evaluate this architectural proposal / design. Spot missing edge cases, security risks, or scalability flaws, and suggest the optimal pattern.\n\n"
            f"PROPOSAL / PROBLEM:\n{prompt}\n\n"
            f"CONTEXT:\n{context or ''}\n"
        )
    elif mode == "debug":
        return (
            f"{system_preamble}\n"
            "TASK: Diagnose this persistent error. Identify the root cause and provide the cleanest surgical fix.\n\n"
            f"ERROR / PROBLEM:\n{prompt}\n\n"
            f"SNIPPET / CONTEXT:\n{context or ''}\n"
        )
    else:
        return f"{system_preamble}\nQUERY:\n{prompt}\n\nCONTEXT:\n{context or ''}\n"

def query_claude(prompt: str, context: str = None, diff: str = None, mode: str = "general") -> str:
    claude_path = _resolve("claude", _HOME / ".local" / "bin" / "claude.exe", _HOME / ".local" / "bin" / "claude")

    full_prompt = build_prompt(prompt, context=context, diff=diff, mode=mode)

    # Strip all 370+ remote MCP tools to prevent burning 304,000 tokens per call
    empty_mcp_config = os.path.join(os.path.dirname(__file__), "empty-mcp.json")
    cmd = [
        claude_path,
        "-p",
        "--tools=",
        "--strict-mcp-config",
        "--mcp-config", empty_mcp_config
    ]

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    proc = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env
        )

        stdout, stderr = proc.communicate(input=full_prompt, timeout=120)
        output = stdout.strip()

        if proc.returncode != 0:
            if "session limit" in output.lower() or "rate limit" in output.lower():
                return f"[Claude Advisor Session Limit]: {output}"
            clean_err = stderr.strip()
            return f"[Error from Claude Advisor (exit code {proc.returncode})]: {output or clean_err}"

        clean_lines = []
        for line in output.splitlines():
            if "Permission allow rule" in line or "Warning: no stdin data received" in line:
                continue
            clean_lines.append(line)

        return "\n".join(clean_lines).strip()

    except subprocess.TimeoutExpired:
        if proc:
            kill_process_tree(proc.pid)
        return "[Error: Claude Advisor timed out after 120s (process tree killed)]"
    except Exception as e:
        if proc:
            kill_process_tree(proc.pid)
        return f"[Error calling Claude Advisor: {e}]"

def query_codex(prompt: str, context: str = None, diff: str = None, mode: str = "general") -> str:
    codex_path = _resolve("codex", _LOCAL_APPDATA / "Programs" / "OpenAI" / "Codex" / "bin" / "codex.exe")

    full_prompt = build_prompt(prompt, context=context, diff=diff, mode=mode)

    temp_out_path = ""
    try:
        with tempfile.NamedTemporaryFile(mode="w+", delete=False, suffix=".txt", encoding="utf-8") as temp_out:
            temp_out_path = temp_out.name

        cmd = [
            codex_path,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--skip-git-repo-check",
            "-s", "read-only",
            "-o", temp_out_path,
            "-"
        ]

        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"

        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env
        )

        stdout, stderr = proc.communicate(input=full_prompt, timeout=120)

        # Read pure model response from isolated output file
        if os.path.exists(temp_out_path):
            with open(temp_out_path, "r", encoding="utf-8", errors="replace") as f:
                agent_output = f.read().strip()
            if agent_output:
                return agent_output

        # Fallback to parsing stdout if file was empty
        clean_lines = []
        capture = False
        for line in stdout.splitlines():
            if line.strip() == "codex":
                capture = True
                continue
            if "tokens used" in line:
                capture = False
                continue
            if capture:
                clean_lines.append(line)

        parsed = "\n".join(clean_lines).strip()
        if parsed:
            return parsed

        if proc.returncode != 0:
            return f"[Error from Codex Advisor (exit code {proc.returncode})]: {stderr.strip() or stdout.strip()}"

        return stdout.strip()

    except subprocess.TimeoutExpired:
        if 'proc' in locals() and proc:
            kill_process_tree(proc.pid)
        return "[Error: OpenAI Codex timed out after 120s (process tree killed)]"
    except Exception as e:
        if 'proc' in locals() and proc:
            kill_process_tree(proc.pid)
        return f"[Error calling OpenAI Codex: {e}]"
    finally:
        if temp_out_path and os.path.exists(temp_out_path):
            try:
                os.remove(temp_out_path)
            except Exception:
                pass

def query_competition(
    prompt: str,
    context: str = None,
    diff: str = None,
    mode: str = "general",
    timeout: int = 180,
    advisor_names: tuple = ("claude", "codex")
) -> str:
    """Executes concurrent dual-advisor review & structured synthesis via Triad Competition Council."""
    _, comp = _import_triad()
    if comp is not None:
        session = comp.query_competition_council(
            prompt,
            context=context,
            diff=diff,
            mode=mode,
            timeout=timeout,
            advisor_names=advisor_names
        )
        return session.get("synthesis", "")
    else:
        # Fallback to auto mode if triad engine is not found
        return query_advisor(prompt, context=context, diff=diff, mode=mode, engine="auto")

def query_advisor(
    prompt: str,
    context: str = None,
    diff: str = None,
    mode: str = "general",
    engine: str = "auto",
    competition: bool = False,
    timeout: int = 180
) -> str:
    if competition or engine == "competition":
        advisors = ("mock", "mock") if engine == "mock" else ("claude", "codex")
        return query_competition(prompt, context=context, diff=diff, mode=mode, timeout=timeout, advisor_names=advisors)

    # Preferred path: the shared, config-driven advisor manager (advisors.json priorities,
    # Nous/Ollama/mock advisors, structured failover, telemetry). This keeps the skill in
    # lock-step with `triad review/consult/debug`.
    am, _ = _import_triad()
    if am is not None:
        return am.query_configured_advisor(engine or "auto", prompt, context=context, diff=diff, mode=mode, timeout=timeout)

    # Standalone fallback (skill copied without the triad package)
    if engine not in (None, "auto", "claude", "codex"):
        raise RuntimeError(
            f"Advisor {engine!r} requires the shared Triad manager"
        )

    if engine == "codex":
        return query_codex(prompt, context=context, diff=diff, mode=mode)
    elif engine == "claude":
        return query_claude(prompt, context=context, diff=diff, mode=mode)

    # Auto mode: try Claude first, failover to Codex if session/rate limited or errored
    claude_resp = query_claude(prompt, context=context, diff=diff, mode=mode)
    if "session limit" in claude_resp.lower() or "rate limit" in claude_resp.lower() or claude_resp.startswith("[Error"):
        codex_resp = query_codex(prompt, context=context, diff=diff, mode=mode)
        header = f"[Advisor Auto-Failover: Claude unavailable ({claude_resp.strip()}). Active Advisor: OpenAI Codex (gpt-6-astra)]\n\n"
        return header + codex_resp

    return claude_resp

def main():
    parser = argparse.ArgumentParser(description="Query Claude or OpenAI Codex as an autonomous advisor.")
    parser.add_argument("prompt", nargs="?", default="", help="The question or task prompt")
    parser.add_argument("--mode", choices=["general", "review_diff", "architect", "debug"], default="general")
    parser.add_argument("--engine", default="auto", help="Advisor engine: auto (priority failover), competition, or any advisors.json name (claude, codex, nous, ollama, mock)")
    parser.add_argument("--competition", action="store_true", help="Execute Claude Code & OpenAI Codex concurrently with structured synthesis")
    parser.add_argument("--context", default="", help="Relevant code or context")
    parser.add_argument("--diff-file", default="", help="Path to a diff file or - for stdin")
    parser.add_argument("--timeout", type=int, default=180, help="Advisor query timeout in seconds (default 180)")

    args = parser.parse_args()

    diff_content = ""
    if args.diff_file:
        if args.diff_file == "-":
            diff_content = sys.stdin.read()
        elif os.path.exists(args.diff_file):
            with open(args.diff_file, "r", encoding="utf-8", errors="replace") as f:
                diff_content = f.read()

    prompt = args.prompt
    if not prompt and not sys.stdin.isatty() and args.diff_file != "-":
        prompt = sys.stdin.read().strip()

    if not prompt and not diff_content:
        print("Usage: python advisor.py '<prompt>' [--mode architect|review_diff|debug] [--engine auto|claude|codex|competition] [--competition] [--context '...']")
        sys.exit(1)

    response = query_advisor(
        prompt,
        context=args.context,
        diff=diff_content,
        mode=args.mode,
        engine=args.engine,
        competition=args.competition,
        timeout=args.timeout
    )
    print(response)

if __name__ == "__main__":
    main()
