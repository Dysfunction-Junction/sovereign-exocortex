"""
Persistent advisor circuit breaker.

When Claude (or any advisor) hits a session/rate limit, the next ``triad review``
used to wait the full subprocess timeout (often 120s) before failing over.
This module records the failure and skips that advisor until the cooldown
expires, turning the common "Claude is rate-limited" case from a two-minute
hang into an instant skip.

State is shared across the repo checkout and the ``~/.agents/triad`` install
so a limit discovered by ``triad doctor`` is visible to ``triad gate`` and
the ambient HTTP daemon.

Disable with ``TRIAD_CIRCUIT=0``. Override the state file with
``TRIAD_CIRCUIT_PATH``. Cooldown lengths: ``TRIAD_CIRCUIT_LIMIT_SECONDS``
(default 1800), ``TRIAD_CIRCUIT_ERROR_SECONDS`` (45),
``TRIAD_CIRCUIT_TIMEOUT_SECONDS`` (90).
"""

from __future__ import annotations

import json
import os
import sys
import time
import tempfile
import threading
import contextlib
from pathlib import Path
from typing import Any, Dict, Optional

_CIRCUIT_LOCK = threading.RLock()


@contextlib.contextmanager
def _interprocess_file_lock(timeout: float = 2.0):
    lock_path = circuit_state_path().with_suffix(".lock")
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    lock_fd = None
    acquired = False
    deadline = time.time() + timeout
    try:
        lock_fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o666)
        while time.time() < deadline:
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(lock_fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except (IOError, OSError):
                time.sleep(0.02)
    except Exception:
        acquired = False

    try:
        yield acquired
    finally:
        if acquired and lock_fd is not None:
            try:
                if os.name == "nt":
                    import msvcrt
                    try:
                        msvcrt.locking(lock_fd, msvcrt.LK_UNLCK, 1)
                    except Exception:
                        pass
                else:
                    import fcntl
                    try:
                        fcntl.flock(lock_fd, fcntl.LOCK_UN)
                    except Exception:
                        pass
            except Exception:
                pass
        if lock_fd is not None:
            try:
                os.close(lock_fd)
            except Exception:
                pass

_DEFAULT_COOLDOWNS = {
    "limit": 1800,
    "error": 45,
    "timeout": 90,
    "empty": 45,
}

_ENV_COOLDOWNS = {
    "limit": "TRIAD_CIRCUIT_LIMIT_SECONDS",
    "error": "TRIAD_CIRCUIT_ERROR_SECONDS",
    "timeout": "TRIAD_CIRCUIT_TIMEOUT_SECONDS",
    "empty": "TRIAD_CIRCUIT_ERROR_SECONDS",
}

TRIP_AFTER = {
    "limit": 1,
    "error": 2,
    "timeout": 2,
    "empty": 2,
}


def circuits_enabled() -> bool:
    return os.environ.get("TRIAD_CIRCUIT", "1").strip().lower() not in ("0", "false", "no", "off")


def circuit_state_path() -> Path:
    override = os.environ.get("TRIAD_CIRCUIT_PATH", "").strip()
    if override:
        return Path(os.path.expanduser(os.path.expandvars(override)))
    return Path.home() / ".agents" / "triad" / "logs" / "circuit_state.json"


def cooldown_seconds(kind: str) -> int:
    env_name = _ENV_COOLDOWNS.get(kind, "")
    raw = os.environ.get(env_name, "").strip() if env_name else ""
    if raw.isdigit():
        return max(0, int(raw))
    return _DEFAULT_COOLDOWNS.get(kind, 45)


def _load_unlocked(path: Path) -> Dict[str, Any]:
    try:
        if path.exists():
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def _save_unlocked(path: Path, data: Dict[str, Any]) -> None:
    tmp_path = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        tmp_path = Path(tmp)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        replaced = False
        for i in range(5):
            try:
                os.replace(str(tmp_path), str(path))
                replaced = True
                break
            except PermissionError:
                time.sleep(0.02 * (i + 1))
        if not replaced and tmp_path.exists():
            tmp_path.unlink()
    except Exception:
        if tmp_path and tmp_path.exists():
            try:
                tmp_path.unlink()
            except Exception:
                pass


def _load() -> Dict[str, Any]:
    # Writes are atomic via tempfile + os.replace; lockless reads eliminate
    # multi-round-trip lock contention on status and routing checks.
    with _CIRCUIT_LOCK:
        return _load_unlocked(circuit_state_path())


def _save(data: Dict[str, Any]) -> None:
    with _CIRCUIT_LOCK, _interprocess_file_lock() as acquired:
        if not acquired:
            return
        _save_unlocked(circuit_state_path(), data)


def _entry_open(entry: Dict[str, Any], now: Optional[float] = None) -> bool:
    now = time.time() if now is None else now
    try:
        return float(entry.get("until", 0) or 0) > now
    except (TypeError, ValueError):
        return False


def is_circuit_open(advisor_name: str) -> bool:
    """True when ``advisor_name`` should be skipped by auto-failover."""
    if not circuits_enabled() or not advisor_name:
        return False
    entry = _load().get(advisor_name.lower())
    if not isinstance(entry, dict):
        return False
    return _entry_open(entry)


def circuit_remaining(advisor_name: str) -> float:
    if not circuits_enabled() or not advisor_name:
        return 0.0
    entry = _load().get(advisor_name.lower())
    if not isinstance(entry, dict):
        return 0.0
    try:
        return max(0.0, float(entry.get("until", 0) or 0) - time.time())
    except (TypeError, ValueError):
        return 0.0


def circuit_reason(advisor_name: str) -> str:
    entry = _load().get((advisor_name or "").lower())
    if not isinstance(entry, dict):
        return ""
    return str(entry.get("reason") or "")


def record_success(advisor_name: str, track_circuit: bool = True, call_start_time: Optional[float] = None) -> None:
    """Close the circuit and reset the failure streak."""
    if not circuits_enabled() or not advisor_name or not track_circuit:
        return
    key = advisor_name.lower()
    path = circuit_state_path()
    with _CIRCUIT_LOCK, _interprocess_file_lock() as acquired:
        if not acquired:
            print(f"[Triad Circuit Warning] Could not acquire circuit lock to record success for {advisor_name}; skipping update", file=sys.stderr)
            return  # Skip best-effort update on contention; never mutate unlocked
        data = _load_unlocked(path)
        prev = data.get(key) if isinstance(data.get(key), dict) else {}

        now = time.time()
        call_start = call_start_time if call_start_time is not None else now
        prev_fail_start = float(prev.get("last_failure_start") or prev.get("last_failure") or 0)

        # Stale completion protection:
        # A success is stale if a newer request that started AFTER this success has already failed.
        is_stale_for_failure = (
            call_start_time is not None
            and prev_fail_start > call_start
        )
        if prev.get("state") == "open" and _entry_open(prev):
            if is_stale_for_failure:
                return  # Never close an open circuit with a stale completion

        # If this success started before the last failure, update last_success without clearing failures streak
        if is_stale_for_failure:
            data[key] = {
                "state": prev.get("state", "closed"),
                "reason": prev.get("reason"),
                "failures": prev.get("failures", 0),
                "until": prev.get("until", 0),
                "last_success": now,
                "last_success_start": call_start,
                "last_failure": prev.get("last_failure"),
                "last_failure_start": prev.get("last_failure_start"),
                "last_call_start": call_start,
            }
        else:
            data[key] = {
                "state": "closed",
                "reason": None,
                "failures": 0,
                "until": 0,
                "last_success": now,
                "last_success_start": call_start,
                "last_failure": prev.get("last_failure"),
                "last_failure_start": prev.get("last_failure_start"),
                "last_call_start": call_start,
            }
        _save_unlocked(path, data)


def record_failure(advisor_name: str, kind: str, track_circuit: bool = True, call_start_time: Optional[float] = None) -> None:
    """
    Record an advisor failure. Opens the breaker on limits (1 failure) or after 2 consecutive
    transient errors/timeouts to prevent cold-starts and short timeouts from poisoning circuits.
    """
    if not circuits_enabled() or not advisor_name or not track_circuit:
        return
    key = advisor_name.lower()
    kind = (kind or "error").lower()
    if kind not in _DEFAULT_COOLDOWNS:
        kind = "error"
    path = circuit_state_path()
    with _CIRCUIT_LOCK, _interprocess_file_lock() as acquired:
        if not acquired:
            print(f"[Triad Circuit Warning] Could not acquire circuit lock to record failure for {advisor_name}; skipping update", file=sys.stderr)
            return  # Skip best-effort update on contention; never mutate unlocked
        data = _load_unlocked(path)
        prev = data.get(key) if isinstance(data.get(key), dict) else {}

        now = time.time()
        call_start = call_start_time if call_start_time is not None else now

        # Stale failure protection: if a newer request that started AFTER this call started has
        # already succeeded, discard this failure to prevent an obsolete timeout/error from reopening or poisoning the circuit.
        last_succ_start = float(prev.get("last_success_start") or prev.get("last_success") or 0)
        if call_start_time is not None and last_succ_start > call_start:
            return

        last_failure = float(prev.get("last_failure") or 0)
        prev_cooldown = cooldown_seconds(prev.get("reason") or kind)
        if last_failure > 0 and (now - last_failure) > max(prev_cooldown, 300):
            failures = 1
        else:
            failures = int(prev.get("failures") or 0) + 1
        threshold = TRIP_AFTER.get(kind, 2)

        prev_until = float(prev.get("until") or 0)
        is_currently_open = _entry_open(prev, now=now)

        if failures < threshold and not is_currently_open:
            data[key] = {
                "state": "closed",
                "reason": None,
                "failures": failures,
                "until": 0,
                "last_failure": now,
                "last_failure_start": call_start,
                "last_success": prev.get("last_success"),
                "last_success_start": prev.get("last_success_start"),
            }
            _save_unlocked(path, data)
            return

        base = cooldown_seconds(kind)
        if kind == "limit":
            delay = base
        else:
            multiplier = 2 ** min(max(failures - threshold, 0), 3)
            delay = min(base * multiplier, 600)
        until = now + delay

        effective_reason = kind
        # Preserve longer existing cooldowns (e.g. rate limit of 1800s should not be shortened by 45s error)
        if is_currently_open and prev_until > until:
            until = prev_until
            if prev.get("reason") == "limit":
                effective_reason = "limit"

        data[key] = {
            "state": "open",
            "reason": effective_reason,
            "failures": failures,
            "until": until,
            "until_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(until)),
            "last_failure": now,
            "last_failure_start": call_start,
            "last_success": prev.get("last_success"),
            "last_success_start": prev.get("last_success_start"),
        }
        _save_unlocked(path, data)


def reset_circuit(advisor_name: Optional[str] = None) -> None:
    """Clear one advisor's circuit, or every circuit when ``advisor_name`` is None."""
    path = circuit_state_path()
    with _CIRCUIT_LOCK, _interprocess_file_lock() as acquired:
        if not acquired:
            return
        if advisor_name:
            data = _load_unlocked(path)
            data.pop(advisor_name.lower(), None)
            _save_unlocked(path, data)
            return
        try:
            if path.exists():
                path.unlink()
        except Exception:
            _save_unlocked(path, {})


def snapshot_circuits() -> Dict[str, Any]:
    """Structured view for ``triad doctor`` and ``GET /health``."""
    now = time.time()
    out: Dict[str, Any] = {}
    if not circuits_enabled():
        return {"enabled": False, "advisors": out}
    for name, entry in _load().items():
        if not isinstance(entry, dict):
            continue
        opened = _entry_open(entry, now)
        try:
            remaining = max(0, int(float(entry.get("until", 0) or 0) - now)) if opened else 0
        except (TypeError, ValueError):
            remaining = 0
        out[name] = {
            "state": "open" if opened else "closed",
            "reason": entry.get("reason"),
            "failures": int(entry.get("failures") or 0),
            "remaining_seconds": remaining,
            "until": entry.get("until_iso") or "",
        }
    return {"enabled": True, "advisors": out, "path": str(circuit_state_path())}


__all__ = [
    "circuits_enabled",
    "circuit_state_path",
    "cooldown_seconds",
    "is_circuit_open",
    "circuit_remaining",
    "circuit_reason",
    "record_success",
    "record_failure",
    "reset_circuit",
    "snapshot_circuits",
]
