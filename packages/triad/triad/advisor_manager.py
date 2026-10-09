#!/usr/bin/env python3
"""
Autonomous Multi-Agent Triad: Advisor Manager (advisor_manager.py).
Config-driven management and dynamic query routing for advisory models:
- Loads declarative configurations from advisors.json.
- Supports runtime inspection (get_advisors, get_active_advisor).
- Executes queries against configured advisors (Claude, Codex, Ollama, Mock, or custom).
- Allows dynamic registration of new advisors without modifying engine code.
"""

import sys
import os
import subprocess
import json
import time
import tempfile
import shutil
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List, Optional, Any, Union, Tuple, Generator

try:
    from triad.procutil import (
        kill_process_tree, is_failed_advisor_response, classify_advisor_response,
        is_port_open, strip_diff_bloat,
    )
    from triad.paths import expand_path, PORT_OLLAMA, CLAUDE_PATH, CODEX_PATH, HERMES_PATH, OLLAMA_PATH
    from triad.circuit import (
        is_circuit_open, circuit_remaining, circuit_reason,
        record_success, record_failure,
    )
except ImportError:  # flat install (~/.agents/triad) without the package prefix
    from procutil import (
        kill_process_tree, is_failed_advisor_response, classify_advisor_response,
        is_port_open, strip_diff_bloat,
    )
    from paths import expand_path, PORT_OLLAMA, CLAUDE_PATH, CODEX_PATH, HERMES_PATH, OLLAMA_PATH
    from circuit import (
        is_circuit_open, circuit_remaining, circuit_reason,
        record_success, record_failure,
    )

# Ensure UTF-8 console output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

TRIAD_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = TRIAD_DIR / "advisors.json"
DEFAULT_EMPTY_MCP = TRIAD_DIR / "empty-mcp.json"
LOGS_DIR = TRIAD_DIR / "logs"
ADVISOR_CALLS_LOG = LOGS_DIR / "advisor_calls.jsonl"

LIMIT_MARKERS = ("session limit", "rate limit", "usage limit")
TEST_ROLES = frozenset({"test", "mock"})


def test_advisors_allowed() -> bool:
    """Explicit ``--engine mock`` still works; this only gates *auto* failover."""
    return os.environ.get("TRIAD_ALLOW_MOCK", "").strip().lower() in ("1", "true", "yes", "on")


def is_test_advisor(advisor: Dict[str, Any]) -> bool:
    name = str(advisor.get("name") or "").lower()
    role = str(advisor.get("role") or "").lower()
    return name == "mock" or role in TEST_ROLES


def _resolve_readiness_port(advisor: Dict[str, Any]) -> Optional[int]:
    raw = advisor.get("readiness_port")
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        token = raw.strip()
        if token in ("{port_ollama}", "ollama"):
            return PORT_OLLAMA
        if token.isdigit():
            return int(token)
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def advisor_is_ready(advisor: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Cheap preflight: skip advisors whose local daemon is down or whose binary
    cannot be resolved, instead of burning the full subprocess timeout.
    """
    port = _resolve_readiness_port(advisor)
    if port is not None and not is_port_open("127.0.0.1", port, timeout=0.2):
        return False, f"port {port} closed"
    raw = advisor.get("binary_path", "")
    fallback = advisor.get("fallback_binary")
    if not raw and not fallback:
        return True, ""
    resolved = resolve_binary(str(raw), fallback, advisor_name=advisor.get("name"))
    if not resolved:
        return False, "no binary resolved"
    if resolved in ("python", "python3", sys.executable):
        return True, ""
    path = Path(resolved)
    try:
        if path.exists() or shutil.which(resolved):
            return True, ""
    except OSError:
        pass
    return False, f"binary not found: {resolved}"


def _record_circuit_outcome(advisor: Dict[str, Any], text: str, track_circuit: bool = True, call_start_time: Optional[float] = None) -> None:
    if not track_circuit:
        return
    if is_test_advisor(advisor):
        return
    name = str(advisor.get("name") or "")
    if not name:
        return
    try:
        kind = classify_advisor_response(text)
        if kind == "ok":
            record_success(name, track_circuit=True, call_start_time=call_start_time)
        elif kind in ("limit", "error", "empty", "timeout"):
            record_failure(name, kind, track_circuit=True, call_start_time=call_start_time)
    except Exception:
        pass


def _telemetry_enabled() -> bool:
    return os.environ.get("TRIAD_TELEMETRY", "1").strip().lower() not in ("0", "false", "no", "off")


def record_advisor_call(advisor_name: str, mode: str, elapsed_seconds: float, status: str, prompt_chars: int = 0) -> None:
    """
    Append one line of per-call telemetry (advisor, mode, latency, outcome) to
    ``logs/advisor_calls.jsonl``. Best-effort and silent; disable with TRIAD_TELEMETRY=0.
    """
    if not _telemetry_enabled():
        return
    try:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        with open(ADVISOR_CALLS_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "advisor": advisor_name,
                "mode": mode,
                "status": status,
                "elapsed_seconds": round(elapsed_seconds, 2),
                "prompt_chars": prompt_chars,
            }) + "\n")
    except Exception:
        pass


def build_advisor_prompt(prompt: str, context: Optional[str] = None, diff: Optional[str] = None, mode: str = "general") -> str:
    """Construct structured advisor prompt based on query mode."""
    if diff:
        diff = strip_diff_bloat(diff)

    system_preamble = (
        "You are the Lead Architect and Code Reviewer acting as the autonomous advisory council to Antigravity (the primary coding agent).\n"
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


def load_config(config_path: Optional[Union[str, Path]] = None) -> Dict[str, Any]:
    """Load advisor configuration JSON from disk."""
    path = Path(config_path).resolve() if config_path else DEFAULT_CONFIG_PATH
    if not path.exists():
        return {"advisors": []}

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return json.load(f)


def save_config(config_data: Dict[str, Any], config_path: Optional[Union[str, Path]] = None) -> None:
    """Save advisor configuration JSON to disk."""
    path = Path(config_path).resolve() if config_path else DEFAULT_CONFIG_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(config_data, f, indent=2)


def get_advisors(
    config_path: Optional[Union[str, Path]] = None,
    enabled_only: bool = False,
    production_only: bool = False,
) -> List[Dict[str, Any]]:
    """
    Return all configured advisors ordered by priority (lower priority number = higher precedence).

    ``production_only`` drops test/mock advisors so auto-failover can never
    rubber-stamp a gate with ``VERDICT: APPROVED`` from the mock engine.
    """
    data = load_config(config_path)
    advisors = data.get("advisors", [])
    if enabled_only:
        advisors = [adv for adv in advisors if adv.get("enabled", True)]
    if production_only:
        advisors = [adv for adv in advisors if not is_test_advisor(adv)]
    return sorted(advisors, key=lambda x: x.get("priority", 999))


def get_active_advisor(name: Optional[str] = None, config_path: Optional[Union[str, Path]] = None) -> Optional[Dict[str, Any]]:
    """
    Retrieve advisor configuration by name (case-insensitive).
    If name is None or 'auto', returns the highest priority active advisor available.
    """
    advisors = get_advisors(config_path=config_path, enabled_only=True)
    if not advisors:
        return None

    if name and name.lower() not in ("auto", "none"):
        target = "claude" if name.lower() == "bare_single" else name.lower()
        for adv in advisors:
            if adv.get("name", "").lower() == target:
                return adv
        return None

    # 'auto' or None: return highest-priority enabled advisor
    return advisors[0]


def _resolve_one(candidate: str) -> Optional[str]:
    """Resolve a single binary spec: python alias -> expanded absolute path -> PATH lookup."""
    if not candidate:
        return None
    if candidate in ("python", "python3"):
        return sys.executable
    expanded = expand_path(candidate)
    if "/" in candidate or "\\" in candidate:
        p = Path(expanded)
        try:
            if p.exists():
                return str(p)
        except OSError:
            pass
    which_bin = shutil.which(expanded) or shutil.which(candidate)
    return which_bin


def expand_env_value(key: str, value: str) -> str:
    """
    Expand path tokens in an advisor env value.

    Ordinary values are returned unchanged. ``expand_path`` rewrites ``$``,
    ``%VAR%`` and a leading ``~``, which corrupts tokens and API keys.
    """
    key_up = key.upper()
    path_key_names = {"PATH", "TEMP", "TMP", "OLLAMA_MODELS", "GOOGLE_APPLICATION_CREDENTIALS"}
    path_like = (
        key_up in path_key_names
        or key_up.endswith(("_PATH", "_DIR", "_FILE", "_HOME", "_ROOT"))
        or "{home}" in value
        or "{localappdata}" in value
        or value == "~"
        or value.startswith("~/")
        or value.startswith("~\\")
    )
    if not path_like:
        return value
    if "://" in value:
        return value
    return str(expand_path(value))


def resolve_binary(binary_path: str, fallback_binary: Optional[str] = None, advisor_name: Optional[str] = None) -> str:
    """
    Resolve an advisor executable with strict precedence:
      1. Explicit environment override (e.g. TRIAD_CLAUDE_PATH)
      2. Configured binary_path
      3. Discovered / canonical default binary (paths.py)
      4. fallback_binary
    """
    name = (advisor_name or "").lower()
    canonical_map = {
        "claude": CLAUDE_PATH,
        "codex": CODEX_PATH,
        "ollama": OLLAMA_PATH,
        "hermes": HERMES_PATH,
    }

    # 1. Explicit environment override
    if name:
        env_var = f"TRIAD_{name.upper()}_PATH"
        env_override = os.environ.get(env_var, "").strip()
        if env_override:
            res_env = _resolve_one(env_override)
            if res_env:
                return res_env

    # 2. Configured binary_path
    if binary_path:
        res_cfg = _resolve_one(binary_path)
        if res_cfg:
            return res_cfg

    # 3. Discovered / canonical default binary
    if name in canonical_map:
        canon = canonical_map[name]
        try:
            if canon.exists():
                return str(canon)
        except OSError:
            pass

    # 4. Fallback binary
    if fallback_binary:
        res_fallback = _resolve_one(fallback_binary)
        if res_fallback:
            return res_fallback

    return binary_path


def add_advisor(advisor_config: Dict[str, Any], config_path: Optional[Union[str, Path]] = None) -> None:
    """
    Dynamically register or update an advisor in the configuration without touching code.
    """
    data = load_config(config_path)
    advisors = data.setdefault("advisors", [])

    name = advisor_config.get("name", "").lower()
    updated = False
    for i, adv in enumerate(advisors):
        if adv.get("name", "").lower() == name:
            advisors[i] = advisor_config
            updated = True
            break

    if not updated:
        advisors.append(advisor_config)

    save_config(data, config_path)


def remove_advisor(advisor_name: str, config_path: Optional[Union[str, Path]] = None) -> bool:
    """Remove an advisor by name from the configuration."""
    data = load_config(config_path)
    advisors = data.get("advisors", [])
    target = advisor_name.lower()
    filtered = [adv for adv in advisors if adv.get("name", "").lower() != target]

    if len(filtered) != len(advisors):
        data["advisors"] = filtered
        save_config(data, config_path)
        return True
    return False


def _execute_single_advisor_raw(
    advisor: Dict[str, Any],
    prompt: str,
    context: Optional[str] = None,
    diff: Optional[str] = None,
    mode: str = "general",
    timeout: int = 120
) -> str:
    """Execute a single advisor using its declared configuration."""
    raw_bin = advisor.get("binary_path", "")
    fallback_bin = advisor.get("fallback_binary")
    bin_path = resolve_binary(raw_bin, fallback_bin, advisor_name=advisor.get("name"))

    full_prompt = build_advisor_prompt(prompt, context=context, diff=diff, mode=mode)
    flags = list(advisor.get("execution_flags", []))
    input_mode = advisor.get("input_mode", "stdin")
    output_mode = advisor.get("output_mode", "stdout")
    advisor_name = advisor.get("name", "unknown")
    display_name = advisor.get("display_name", advisor_name)

    temp_out_path = None
    if output_mode == "file":
        temp_fd, temp_out_path = tempfile.mkstemp(suffix=".txt")
        os.close(temp_fd)

    # Parameter interpolation for flags
    resolved_flags = []
    empty_mcp_str = str(DEFAULT_EMPTY_MCP)
    triad_dir_str = str(TRIAD_DIR)
    for flag in flags:
        flag = flag.replace("{empty_mcp}", empty_mcp_str)
        flag = flag.replace("{triad_dir}", triad_dir_str)
        if temp_out_path:
            flag = flag.replace("{output_file}", temp_out_path)
        if input_mode == "arg":
            flag = flag.replace("{prompt}", full_prompt)
        resolved_flags.append(flag)

    cmd = [bin_path] + resolved_flags

    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    for k, v in advisor.get("env", {}).items():
        env[k] = expand_env_value(str(k), str(v))

    started = time.monotonic()
    proc = None
    try:
        popen_kwargs = {
            "stdin": subprocess.PIPE if input_mode == "stdin" else None,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "env": env,
        }
        if os.name != "nt":
            popen_kwargs["start_new_session"] = True
        proc = subprocess.Popen(cmd, **popen_kwargs)

        stdin_data = full_prompt if input_mode == "stdin" else None
        stdout, stderr = proc.communicate(input=stdin_data, timeout=timeout)

        # Output collection
        output = ""
        if output_mode == "file" and temp_out_path and os.path.exists(temp_out_path):
            try:
                with open(temp_out_path, "r", encoding="utf-8", errors="replace") as f:
                    output = f.read().strip()
            except Exception:
                output = ""

        if not output:
            output = stdout.strip()

        # Handle process exit codes
        if proc.returncode != 0:
            err_msg = stderr.strip() or output
            # Inspect first ~5 non-empty lines of stderr and output for authoritative limit notices
            # (handles warning lines like Node deprecation warnings preceding limit notices)
            err_lines = [l.strip().lower() for l in stderr.splitlines() if l.strip()][:5]
            out_lines = [l.strip().lower() for l in output.splitlines() if l.strip()][:5]
            checked_lines = err_lines + out_lines
            is_limit = any(any(marker in line for marker in LIMIT_MARKERS) for line in checked_lines)
            if is_limit:
                record_advisor_call(advisor_name, mode, time.monotonic() - started, "limit", len(full_prompt))
                return f"[{display_name} Session Limit]: {output or err_msg}"
            record_advisor_call(advisor_name, mode, time.monotonic() - started, "error", len(full_prompt))
            return f"[Error from {display_name} (exit code {proc.returncode})]: {err_msg}"

        # Advisor-specific cleaning
        if advisor_name.lower() == "claude":
            clean_lines = []
            for line in output.splitlines():
                if "Permission allow rule" in line or "Warning: no stdin data received" in line:
                    continue
                clean_lines.append(line)
            output = "\n".join(clean_lines).strip()

        elif advisor_name.lower() == "codex" and not output_mode == "file":
            clean_lines = []
            capture = False
            for line in output.splitlines():
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
                output = parsed

        record_advisor_call(advisor_name, mode, time.monotonic() - started, "ok" if output else "empty", len(full_prompt))
        return output

    except subprocess.TimeoutExpired:
        if proc:
            kill_process_tree(proc.pid)
        record_advisor_call(advisor_name, mode, time.monotonic() - started, "timeout", len(full_prompt))
        return f"[Error: {display_name} timed out after {timeout}s (process tree killed)]"
    except Exception as e:
        if proc:
            kill_process_tree(proc.pid)
        record_advisor_call(advisor_name, mode, time.monotonic() - started, "error", len(full_prompt))
        return f"[Error calling {display_name}: {e}]"
    finally:
        if proc:
            try:
                kill_process_tree(proc.pid)
            except Exception:
                pass
        if temp_out_path and os.path.exists(temp_out_path):
            try:
                os.remove(temp_out_path)
            except Exception:
                pass


class SessionSlotUnavailable(TimeoutError):
    """A live model session slot could not be acquired. This is not an advisor failure."""


class ModelSessionLimiter:
    """
    Global concurrency gate for LLM advisory model sessions (Non-negotiable #2: never exceed 2 concurrent sessions).
    Enforces concurrency bounds both intra-process (BoundedSemaphore) and inter-process (slot file locks).

    Take slots with ``acquire()``. One advisor call takes one slot. Do not wrap a call that
    already acquires internally; that consumes both slots and stalls the second worker.
    """
    def __init__(self, max_concurrent: int = 2, timeout: float = 300.0, slot_dir: Optional[Union[str, Path]] = None):
        self.max_concurrent = max(1, min(int(max_concurrent), 2))
        self.timeout = timeout
        self._thread_semaphore = threading.BoundedSemaphore(self.max_concurrent)
        self._slot_dir = Path(slot_dir) if slot_dir is not None else Path(tempfile.gettempdir()) / "triad_session_slots"
        self._ctx_local = threading.local()

    def _lock_slot(self, fd: int) -> None:
        if os.name == "nt":
            import msvcrt
            # msvcrt.locking fails on an empty file because the locked byte is past EOF.
            if os.lseek(fd, 0, os.SEEK_END) < 1:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock_slot(self, fd: int) -> None:
        if os.name == "nt":
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_UN)

    @contextmanager
    def acquire(self, timeout: Optional[float] = None) -> Generator[int, None, None]:
        wait_timeout = timeout if timeout is not None else self.timeout
        start_time = time.monotonic()

        # 1. Intra-process acquisition
        acquired_sem = self._thread_semaphore.acquire(timeout=wait_timeout)
        if not acquired_sem:
            raise SessionSlotUnavailable("Timed out waiting for intra-process model session slot")

        slot_fd = None
        slot_idx = -1
        try:
            try:
                self._slot_dir.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                raise SessionSlotUnavailable(
                    f"Could not create session slot dir {self._slot_dir}: {exc}"
                ) from exc
            deadline = start_time + wait_timeout

            # 2. Inter-process slot acquisition
            while slot_fd is None:
                open_failures = 0
                lock_failures = 0
                open_error: Optional[BaseException] = None
                for idx in range(self.max_concurrent):
                    slot_path = self._slot_dir / f"slot_{idx}.lock"
                    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
                    try:
                        fd = os.open(str(slot_path), flags, 0o600)
                    except OSError as exc:
                        open_failures += 1
                        open_error = exc
                        continue

                    try:
                        self._lock_slot(fd)
                        slot_fd = fd
                        slot_idx = idx
                        break
                    except (OSError, IOError):
                        lock_failures += 1
                        try:
                            os.close(fd)
                        except Exception:
                            pass

                if slot_fd is not None:
                    break

                if open_failures == self.max_concurrent and lock_failures == 0:
                    raise SessionSlotUnavailable(
                        f"Could not open model session slots in {self._slot_dir}: {open_error}"
                    )

                if time.monotonic() >= deadline:
                    raise SessionSlotUnavailable("Timed out waiting for inter-process model session slot")
                if not getattr(self, "_announced_wait", False):
                    print(
                        "[Triad] Waiting for a model session slot (2 live calls max). This wait is not a model failure.",
                        file=sys.stderr,
                    )
                    self._announced_wait = True
                time.sleep(0.05)

            yield slot_idx

        finally:
            if slot_fd is not None:
                try:
                    self._unlock_slot(slot_fd)
                except Exception:
                    pass
                try:
                    os.close(slot_fd)
                except Exception:
                    pass
            self._thread_semaphore.release()

    def __enter__(self):
        ctx = self.acquire()
        self._ctx_local.ctx = ctx
        return ctx.__enter__()

    def __exit__(self, exc_type, exc_val, exc_tb):
        ctx = getattr(self._ctx_local, "ctx", None)
        if ctx is not None:
            self._ctx_local.ctx = None
            return ctx.__exit__(exc_type, exc_val, exc_tb)


GLOBAL_MODEL_SESSION_LIMITER = ModelSessionLimiter(max_concurrent=2)


def _execute_single_advisor(
    advisor: Dict[str, Any],
    prompt: str,
    context: Optional[str] = None,
    diff: Optional[str] = None,
    mode: str = "general",
    timeout: int = 120,
    track_circuit: bool = True,
) -> str:
    # Mock/test advisors are hermetic and must not consume the two live session slots.
    is_test_advisor = (
        str(advisor.get("role", "")).lower() == "test"
        or str(advisor.get("name", "")).lower() == "mock"
    )
    if is_test_advisor:
        start_time = time.time()
        result = _execute_single_advisor_raw(
            advisor, prompt, context=context, diff=diff, mode=mode, timeout=timeout
        )
    else:
        try:
            # Two workers can each run a pair of advisors, so a request may wait
            # through two full holds before a slot frees.
            slot_budget = (2 * float(timeout)) + 30.0
        except (TypeError, ValueError):
            slot_budget = 270.0
        try:
            with GLOBAL_MODEL_SESSION_LIMITER.acquire(timeout=slot_budget):
                # Start the clock after the slot is held so queue time is not an advisor failure.
                start_time = time.time()
                result = _execute_single_advisor_raw(
                    advisor, prompt, context=context, diff=diff, mode=mode, timeout=timeout
                )
        except SessionSlotUnavailable as exc:
            # Do not record a circuit outcome. Slot contention is not an advisor failure.
            return f"[Error: session slot unavailable: {exc}]"
    try:
        _record_circuit_outcome(advisor, result, track_circuit=track_circuit, call_start_time=start_time)
    except Exception:
        pass
    return result


def query_configured_advisor(
    advisor_name: str,
    prompt: str,
    context: Optional[str] = None,
    diff: Optional[str] = None,
    mode: str = "general",
    timeout: int = 120,
    config_path: Optional[Union[str, Path]] = None,
    track_circuit: bool = True,
    force_probe: bool = False,
) -> str:
    """
    Query an advisor defined in advisors.json by name.
    If advisor_name is 'auto', attempts advisors in priority order with zero-downtime failover.
    """
    if advisor_name.lower() == "auto":
        advisors = get_advisors(
            config_path=config_path,
            enabled_only=True,
            production_only=not test_advisors_allowed(),
        )
        if not advisors:
            return "[Error: No enabled advisors found in configuration]"

        fail_notes = []
        skipped = []
        for adv in advisors:
            name = str(adv.get("name") or "unknown")
            if is_circuit_open(name):
                rem = int(circuit_remaining(name))
                reason = circuit_reason(name) or "cooldown"
                skipped.append(f"{name}: circuit open ({reason}, {rem}s left)")
                print(f"[Triad Circuit] Skipping {name} (open: {reason}, {rem}s remaining)", file=sys.stderr)
                continue
            ready, why = advisor_is_ready(adv)
            if not ready:
                skipped.append(f"{name}: {why}")
                print(f"[Triad Ready] Skipping {name} ({why})", file=sys.stderr)
                continue
            adv_timeout = int(adv.get("timeout") or timeout)
            res = _execute_single_advisor(adv, prompt, context=context, diff=diff, mode=mode, timeout=adv_timeout, track_circuit=track_circuit)
            if not is_failed_advisor_response(res):
                if fail_notes or skipped:
                    prior = "; ".join(fail_notes + skipped)
                    header = f"[Advisor Auto-Failover: Preceding advisors failed ({prior}). Active Advisor: {adv.get('display_name')}]\n\n"
                    return header + res
                return res
            fail_notes.append(f"{name}: {res.strip()[:60]}")

        # Circuit protection: if every ready advisor was skipped by an open circuit,
        # respect the cooldown until expiry to prevent retry stampedes, unless force_probe is explicitly requested.
        circuit_skipped = [adv for adv in advisors if is_circuit_open(str(adv.get("name") or "")) and advisor_is_ready(adv)[0]]
        if circuit_skipped and not fail_notes:
            if force_probe:
                best_fallback = min(circuit_skipped, key=lambda a: circuit_remaining(str(a.get("name") or "")))
                name = str(best_fallback.get("name") or "")
                print(f"[Triad Circuit Fallback] Force-probing {name} (earliest cooldown)...", file=sys.stderr)
                res = _execute_single_advisor(best_fallback, prompt, context=context, diff=diff, mode=mode, timeout=timeout, track_circuit=track_circuit)
                if not is_failed_advisor_response(res):
                    header = f"[Advisor Circuit Fallback: Preceding advisors in cooldown. Active Advisor: {best_fallback.get('display_name')}]\n\n"
                    return header + res
                fail_notes.append(f"{name} (fallback): {res.strip()[:60]}")
            else:
                earliest_adv = min(circuit_skipped, key=lambda a: circuit_remaining(str(a.get("name") or "")))
                rem = int(circuit_remaining(str(earliest_adv.get("name") or "")))
                reason = circuit_reason(str(earliest_adv.get("name") or "")) or "cooldown"
                return f"[Error: All ready advisors are in cooldown ({earliest_adv.get('name')}: {reason}, {rem}s remaining)]"

        parts = fail_notes + skipped
        detail = "; ".join(parts) if parts else "none ready"
        return f"[Advisor Auto-Failover Exhausted]: All configured advisors failed: {detail}"

    advisor = get_active_advisor(advisor_name, config_path=config_path)
    if not advisor:
        return f"[Error: Advisor '{advisor_name}' not found in configuration]"

    return _execute_single_advisor(advisor, prompt, context=context, diff=diff, mode=mode, timeout=timeout, track_circuit=track_circuit)


if __name__ == "__main__":
    advisors = get_advisors()
    print(f"Loaded {len(advisors)} advisors from configuration:")
    for a in advisors:
        print(f"  - [{a.get('priority')}] {a.get('name')}: {a.get('display_name')} (binary: {a.get('binary_path')})")
