#!/usr/bin/env python3
"""
Autonomous Multi-Agent Triad: Ambient HTTP Server (server.py).
Provides high-availability, zero-token-rent HTTP daemon for:
- /health: Subsystem status and advisor health checks
- /telemetry: Real-time Council session metrics & adjudication history
- /auto: Remote intent classification and autonomous routing
- /gate: Pre-commit ground-truth gate verification
- /review: Dual-advisor diff review & consensus synthesis
"""

import sys
import os
import subprocess
import threading
import hmac
import hashlib
import json
import time
import socket
import urllib.parse
import urllib.request
import urllib.error
import logging
import re
import unicodedata

from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Dict, Any, Optional, List, Tuple

try:
    from triad import __version__ as TRIAD_VERSION
except Exception:
    TRIAD_VERSION = "0.0.0"

try:
    from triad.advisor_manager import query_configured_advisor, get_advisors, ADVISOR_CALLS_LOG
    from triad.competition import query_competition_council, COUNCIL_SESSIONS_LOG
    from triad.intent_engine import classify_intent
    from triad.procutil import is_port_open, clean_git_env
    from triad.paths import MEM0_SCRIPT, PORT_HERMES_RELAY, PORT_PIECES_PROXY, PORT_PIECES_OS, PORT_OLLAMA, PORT_TRIAD_SERVER
    from triad.circuit import snapshot_circuits
except ImportError:
    from advisor_manager import query_configured_advisor, get_advisors, ADVISOR_CALLS_LOG
    from competition import query_competition_council, COUNCIL_SESSIONS_LOG
    from intent_engine import classify_intent
    from procutil import is_port_open, clean_git_env
    from paths import MEM0_SCRIPT, PORT_HERMES_RELAY, PORT_PIECES_PROXY, PORT_PIECES_OS, PORT_OLLAMA, PORT_TRIAD_SERVER
    from circuit import snapshot_circuits

logger = logging.getLogger("triad.server")
_ID_RE = re.compile(r"[A-Za-z0-9_\-]{1,128}")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def _upstream_base() -> str:
    up = os.environ.get("REGISTRY_APP_UPSTREAM", "http://127.0.0.1:39403").rstrip("/")
    p = urllib.parse.urlparse(up)
    if p.scheme not in ("http", "https") or p.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("REGISTRY_APP_UPSTREAM must be loopback http(s)")
    return up

def _safe_int_env(var: str, default: int) -> int:
    try:
        val = os.environ.get(var, "").strip()
        return int(val) if val else default
    except (ValueError, TypeError):
        return default

MAX_BODY_BYTES = _safe_int_env("TRIAD_MAX_BODY_BYTES", 4 * 1024 * 1024)  # 4 MiB
SERVER_TOKEN = os.environ.get("TRIAD_SERVER_TOKEN", "").strip()
PATCHES_DIR = (Path.home() / ".agents" / "triad" / "patches").resolve()
try:
    PATCHES_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    pass


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


_REPO_LOCKS: Dict[str, threading.Lock] = {}
_REPO_LOCKS_GUARD = threading.Lock()


def _get_repo_lock(repo_dir: Path) -> threading.Lock:
    key = str(repo_dir.resolve()).lower() if sys.platform == "win32" else str(repo_dir.resolve())
    with _REPO_LOCKS_GUARD:
        if key not in _REPO_LOCKS:
            _REPO_LOCKS[key] = threading.Lock()
        return _REPO_LOCKS[key]


class RepoNotAllowed(Exception):
    """Raised when a requested repo path falls outside the allowed repo roots."""

    def __init__(self, repo_path: str):
        super().__init__(repo_path)
        self.repo_path = repo_path


def _git_toplevel(directory: str) -> Optional[Path]:
    try:
        ret = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=directory, env=clean_git_env(), capture_output=True, text=True, timeout=5)
        if ret.returncode == 0 and ret.stdout.strip():
            return Path(ret.stdout.strip()).resolve()
    except Exception:
        pass
    return None


def _allowed_repo_roots() -> List[str]:
    """Allowed repo roots as real, case-normalized strings (TRIAD_ALLOWED_REPOS, else this repo only)."""
    raw = os.environ.get("TRIAD_ALLOWED_REPOS", "").strip()
    if raw:
        roots = [p for p in raw.split(os.pathsep) if p.strip()]
    else:
        # Default-deny: only the server's own repository root when TRIAD_ALLOWED_REPOS is unset
        own = _git_toplevel(str(Path(__file__).resolve().parent.parent))
        roots = [str(own)] if own else []
    return [os.path.normcase(os.path.realpath(r)) for r in roots]


def _within_roots(path: str, roots: List[str]) -> bool:
    norm = os.path.normcase(path)
    return any(norm == r or norm.startswith(r + os.sep) for r in roots)


def _resolve_repo_path(repo_arg: Optional[str]) -> Optional[Path]:
    """Resolve repo_arg to its git toplevel. Raises RepoNotAllowed outside the allowed roots; None if not a repo."""
    roots = _allowed_repo_roots()
    target = os.path.realpath(repo_arg) if repo_arg else os.path.realpath(os.getcwd())
    # Containment first, before touching the filesystem.
    if not _within_roots(target, roots):
        raise RepoNotAllowed(target)
    if not os.path.isdir(target):
        return None
    top = _git_toplevel(target)
    if top is not None and not _within_roots(str(top), roots):
        raise RepoNotAllowed(str(top))
    return top
def _public_advisors() -> List[Dict[str, Any]]:
    """Return public, sanitized advisor list stripped of sensitive env vars and local paths."""
    return [
        {
            "name": a.get("name"),
            "display_name": a.get("display_name", a.get("name")),
            "enabled": a.get("enabled", True),
            "priority": a.get("priority", 99),
            "role": a.get("role", "general"),
        }
        for a in get_advisors()
    ]


def _public_circuits() -> Dict[str, Any]:
    """Sanitize circuit snapshot to omit internal file paths."""
    snap = snapshot_circuits()
    return {
        "enabled": snap.get("enabled", True),
        "advisors": snap.get("advisors", {}),
    }


def _safe_patch_path(p: str) -> Optional[Path]:
    if not p:
        return None
    try:
        base = os.path.normcase(os.path.realpath(str(PATCHES_DIR)))
        real = os.path.normcase(os.path.realpath(p))
        # Containment first, before touching the filesystem; trailing sep blocks sibling dirs like "patches_evil".
        if not real.startswith(base + os.sep):
            return None
        if not os.path.isfile(real):
            return None
        return Path(real)
    except Exception:
        return None


def _is_safe_patch_path(p: str) -> bool:
    return _safe_patch_path(p) is not None


def _is_allowed_origin(origin: str) -> bool:
    if not origin or origin.lower() == "null":
        return False
    try:
        parts = urllib.parse.urlsplit(origin)
        if parts.scheme not in ("http", "https"):
            return False
        hostname = (parts.hostname or "").lower()
        return hostname in ("127.0.0.1", "localhost", "::1")
    except Exception:
        return False


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    if not path.exists():
        return rows
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
    except Exception as e:
        print(f"[Server Warning] Failed reading {path.name}: {e}", file=sys.stderr)
    return rows


def _subsystem_status() -> Dict[str, bool]:
    probes = {
        "pieces_os": PORT_PIECES_OS,
        "hermes_relay": PORT_HERMES_RELAY,
        "pieces_proxy": PORT_PIECES_PROXY,
        "ollama": PORT_OLLAMA,
    }
    out: Dict[str, bool] = {}
    with ThreadPoolExecutor(max_workers=len(probes)) as pool:
        futures = {
            name: pool.submit(is_port_open, "127.0.0.1", port, 0.5)
            for name, port in probes.items()
        }
        for name, fut in futures.items():
            try:
                out[name] = bool(fut.result())
            except Exception:
                out[name] = False
    return out


def get_telemetry_summary(limit: int = 50) -> Dict[str, Any]:
    """
    Aggregate council_sessions.jsonl (competition adjudications) and
    advisor_calls.jsonl (every single-advisor call: latency + outcome).
    """
    sessions = _read_jsonl(COUNCIL_SESSIONS_LOG)

    total_sessions = len(sessions)
    modes: Dict[str, int] = {}
    advisors_count: Dict[str, int] = {}
    total_elapsed = 0.0

    for s in sessions:
        m = s.get("mode", "unknown")
        modes[m] = modes.get(m, 0) + 1
        for adv in s.get("advisors", []):
            advisors_count[adv] = advisors_count.get(adv, 0) + 1
        total_elapsed += _safe_float(s.get("elapsed_seconds", 0.0))

    avg_elapsed = round(total_elapsed / total_sessions, 2) if total_sessions > 0 else 0.0
    recent_sessions = list(reversed(sessions[-limit:]))

    # Per-advisor call statistics
    calls = _read_jsonl(ADVISOR_CALLS_LOG)
    per_advisor: Dict[str, Dict[str, Any]] = {}
    for c in calls:
        name = str(c.get("advisor", "unknown"))
        entry = per_advisor.setdefault(name, {"calls": 0, "ok": 0, "limit": 0, "error": 0, "timeout": 0, "empty": 0, "_elapsed": 0.0})
        entry["calls"] += 1
        status = str(c.get("status", "error"))
        if status in entry:
            entry[status] += 1
        entry["_elapsed"] += _safe_float(c.get("elapsed_seconds", 0.0))
    for name, entry in per_advisor.items():
        n = entry["calls"] or 1
        entry["avg_elapsed_seconds"] = round(entry.pop("_elapsed") / n, 2)
        entry["success_rate"] = round(entry["ok"] / n, 3)

    return {
        "total_sessions": total_sessions,
        "modes": modes,
        "advisors_used": advisors_count,
        "avg_elapsed_seconds": avg_elapsed,
        "sessions": recent_sessions,
        "advisor_calls": {
            "total": len(calls),
            "per_advisor": per_advisor,
            "recent": list(reversed(calls[-limit:])),
        },
    }


_MAX_SCAN_CHARS = 256 * 1024
_SEG_SPLIT = re.compile(r"[;&|\n]+")
_TOKEN = re.compile(r"[^\s\"'`()\[\]{}<>,]+")
_GIT_VALUE_OPTS = {"-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"}

_KEYWORD_DESTRUCTIVE = re.compile(
    r"(?<![a-z0-9])(?:delet|drop|destroy|truncat|wip|purg|eras|uninstall|kill|rmdir|rmtree|unlink|mkfs|shred|rimraf)"
    r"|(?:^|[^a-z0-9])(?:pkill|killall|wipefs|dd\s+(?:if|of)=)",
    re.I,
)

_DEVICE_ACTUATION = re.compile(
    r"(?<![a-z0-9])(?:tap|click|swipe|press|type|input|send|call|install|reset|reboot|restart|"
    r"shutdown|power|set|enable|disable|unlock|lock|launch|open|pay|format|flash|push|pull)",
    re.I,
)

_READONLY_DEVICE_PATTERN = re.compile(
    r"\b(?:status|battery|list|show|get|read|check|screenshot|inspect|health)\b",
    re.I,
)


_DASH_RE = re.compile(r"[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]")
_RM = {"rm", "remove-item", "del", "rd", "rmdir"}


def _cmd(tok: str) -> str:
    """Normalize command token: strip leading backslashes, path prefixes, and .exe extension."""
    tok = tok.lstrip("\\").rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return tok[:-4] if tok.endswith(".exe") else tok


def _git_sub(rest: List[str]) -> Tuple[str, List[str]]:
    """Extract git subcommand skipping global flags and flag values (like -C repo)."""
    i = 0
    while i < len(rest):
        x = rest[i]
        if x in _GIT_VALUE_OPTS:
            i += 2
            continue
        if x.startswith("-"):
            i += 1
            continue
        return x, rest[i + 1:]
    return "", []


def _git_sub_destructive(sub: str, args: List[str]) -> bool:
    """Check if git subcommand and arguments constitute a destructive operation."""
    flags = [x for x in args if x.startswith(("-", "+", ":"))]
    if sub == "reset":
        return "--hard" in flags or "--merge" in flags
    if sub == "clean":
        return any(f == "--force" or (f.startswith("-") and not f.startswith("--") and "f" in f) for f in flags)
    if sub == "push":
        return any(
            f.startswith("--force")
            or f.startswith("+")
            or (f.startswith("-") and not f.startswith("--") and ("f" in f or "d" in f))
            or f.startswith(":")
            or f in ("--delete", "--mirror", "--prune")
            for f in args
        )
    if sub == "switch":
        return any(f in ("-f", "--force", "--discard-changes") for f in flags)
    if sub == "branch":
        return any(
            f in ("-d", "--delete", "-f", "--force")
            or (f.startswith("-") and not f.startswith("--") and ("d" in f or "f" in f))
            for f in flags
        )
    if sub == "tag":
        return any(f in ("-d", "--delete") for f in flags)
    if sub == "stash":
        return any(a in ("clear", "drop") for a in args)
    if sub in ("rebase", "filter-branch"):
        return True
    if sub == "reflog":
        return "expire" in args
    if sub == "worktree":
        return any(f in ("-f", "--force") for f in flags) and any(a in ("remove", "prune") for a in args)
    if sub == "gc":
        return any(a.startswith("--prune") for a in args)
    if sub == "update-ref":
        return any(f in ("-d", "--delete") for f in flags)
    if sub == "restore":
        # Only pure staged-only restore is non-destructive to worktree (e.g. unstage)
        # Any restore touching worktree or restoring files directly discards worktree modifications
        return set(flags) != {"--staged"}
    if sub == "checkout":
        if "--" in args or "." in args or any(f in ("-f", "--force", "--ours", "--theirs", "-p", "--patch") for f in flags):
            return True
        positionals = [a for a in args if not a.startswith("-")]
        # e.g. `git checkout HEAD <file>` discards working-tree changes
        return len(positionals) > 1 and "-b" not in flags
    return False


def _git_destructive(tokens: List[str]) -> bool:
    """Check git invocations in linear time across whole token list."""
    idxs = [i for i, t in enumerate(tokens) if _cmd(t) == "git"]
    for n, i in enumerate(idxs):
        end = idxs[n + 1] if n + 1 < len(idxs) else len(tokens)
        sub, args = _git_sub(tokens[i + 1:end])
        if _git_sub_destructive(sub, args):
            return True
    return False


def _shell_destructive(tokens: List[str]) -> bool:
    """Check rm, PowerShell, and cmd destructive file deletions in linear time."""
    idxs = [i for i, t in enumerate(tokens) if _cmd(t) in _RM]
    for n, i in enumerate(idxs):
        end = idxs[n + 1] if n + 1 < len(idxs) else len(tokens)
        cmd_name, args = _cmd(tokens[i]), tokens[i + 1:end]
        if cmd_name == "rm":
            if any(f == "--recursive" or (f.startswith("-") and not f.startswith("--") and "r" in f) for f in args):
                return True
        elif cmd_name in ("del", "rd", "rmdir"):
            lowered = [a.lower() for a in args]
            if any(a in ("/s", "/q", "/f", "/s/q", "/q/s") for a in lowered):
                return True
        elif cmd_name == "remove-item":
            lowered = [a.lower() for a in args]
            if any(a in ("-r", "-recurse", "-force") or a.startswith("-rec") for a in lowered):
                return True
    return False


def _scan_for_destructive_commands(text: str) -> bool:
    """Scan text across linear token segments and bounded keywords."""
    if _KEYWORD_DESTRUCTIVE.search(text):
        return True
    segments = _SEG_SPLIT.split(text)
    for seg in segments:
        tokens = _TOKEN.findall(seg)
        if not tokens:
            continue
        if _git_destructive(tokens) or _shell_destructive(tokens):
            return True
    return False


def _normalize_text(*parts: Optional[str]) -> Tuple[str, bool]:
    raw = "\n".join(p or "" for p in parts)
    raw = raw.replace("\\\r\n", " ").replace("\\\n", " ")
    oversized = len(raw) > _MAX_SCAN_CHARS
    truncated = raw[:_MAX_SCAN_CHARS]
    normalized = unicodedata.normalize("NFKC", truncated)
    cleaned = _DASH_RE.sub("-", normalized)
    if not cleaned.isascii():
        cleaned = "".join(c for c in cleaned if unicodedata.category(c) != "Cf")
    return re.sub(r"[^\S\n]+", " ", cleaned).casefold(), oversized


def _evaluate_action_risk(
    classification: Any,
    text: Optional[str] = "",
    context: Optional[str] = "",
    diff: Optional[str] = ""
) -> Tuple[str, bool, List[str]]:
    """
    Evaluate risk tier and 1-tap approval requirement for autonomous loop gating.
    Fails closed: any error, missing required attribute, oversized input, or destructive command triggers ('high', True).
    Returns (risk_level, approval_required, risk_reasons).
    """
    reasons: List[str] = []

    try:
        high_stakes = getattr(classification, "high_stakes", None)
        if high_stakes is None:
            raise AttributeError("classification object missing required high_stakes attribute")
        if bool(high_stakes):
            reasons.append("high_stakes_domain")

        norm_prompt, prompt_oversized = _normalize_text(text)
        if prompt_oversized:
            reasons.append("oversized_input")

        if _scan_for_destructive_commands(norm_prompt):
            reasons.append("destructive_instruction")

        if context:
            norm_ctx, ctx_oversized = _normalize_text(context)
            if ctx_oversized and "oversized_input" not in reasons:
                reasons.append("oversized_input")
            if _scan_for_destructive_commands(norm_ctx) and "destructive_instruction" not in reasons:
                reasons.append("destructive_payload")

        intent_raw = getattr(classification, "intent", "")
        intent = str(getattr(intent_raw, "value", intent_raw) or "").upper()

        if diff:
            if intent in ("REVIEW", "GATE"):
                diff_to_scan = "\n".join(
                    line[1:] for line in diff.splitlines()
                    if line.startswith("+") and not line.startswith("+++")
                )
            else:
                diff_to_scan = diff

            if diff_to_scan:
                norm_diff, diff_oversized = _normalize_text(diff_to_scan)
                if diff_oversized and "oversized_input" not in reasons:
                    reasons.append("oversized_input")
                if _scan_for_destructive_commands(norm_diff) and "destructive_payload" not in reasons:
                    reasons.append("destructive_payload")

        if reasons:
            return "high", True, reasons

        if intent in ("MEMORY", "DOCTOR", "MICRO", "ARCHITECT", "GENERAL", "GATE", "REVIEW"):
            return "low", False, []

        if intent == "DEVICE":
            if _READONLY_DEVICE_PATTERN.search(norm_prompt) and not _DEVICE_ACTUATION.search(norm_prompt):
                return "low", False, []
            return "medium", True, ["device_actuation"]

        if intent == "MESH":
            return "medium", False, []

        return "medium", True, ["unclassified_intent"]

    except Exception as e:
        return "high", True, [f"risk_eval_error:{type(e).__name__}"]


def _registry_call(action: str, payload: Dict[str, Any], timeout: float = 3.0) -> Tuple[str, Any]:
    """
    Execute loopback call to registry-app with deterministic deduplication and fail-closed error classification.
    Returns: (status_type, detail)
    - ("ok", response_dict)
    - ("rejected", response_dict)
    - ("http", http_status_code)
    - ("unknown", error_str)   # timeout / json decode error / connection reset after send
    - ("unreachable", error_str)  # connection refused / pre-send network error
    """
    try:
        up = _upstream_base()
    except ValueError as e:
        logger.error("Invalid REGISTRY_APP_UPSTREAM configuration: %s", e)
        return "unreachable", str(e)

    prop_id = str(payload.get("proposalId") or payload.get("proposal_id") or "")
    nonce_val = str(payload.get("nonce") or "")
    seed = f"{action}:{prop_id}:{nonce_val}".encode("utf-8")
    det_id = f"triad-{action[:3]}-{hashlib.sha256(seed).hexdigest()[:16]}"
    body = json.dumps({
        "v": 1,
        "id": det_id,
        "from": "autonomous-triad",
        "to": "registry-app",
        "capability": "staging",
        "action": action,
        "payload": payload,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{up}/mishmash/delegate",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            data = json.loads(raw)
        if isinstance(data, dict) and data.get("ok") is True:
            return "ok", data
        return "rejected", data
    except urllib.error.HTTPError as e:
        code = e.code
        e.close()
        return "http", code
    except urllib.error.URLError as e:
        r = e.reason
        if isinstance(r, (ConnectionRefusedError, socket.gaierror)):
            return "unreachable", str(e)
        return "unknown", str(e)
    except ConnectionRefusedError as e:
        return "unreachable", str(e)
    except Exception as e:
        return "unknown", f"{type(e).__name__}: {e}"


class TriadRequestHandler(BaseHTTPRequestHandler):
    """Multi-threaded request handler for Triad Ambient HTTP Bridge."""

    server_version = "TriadHTTP/1.0"

    def _drain_best_effort(self):
        """Drain already-buffered incoming request body with strict 50ms deadline to prevent Winsock RST."""
        try:
            raw_len = self.headers.get("Content-Length", "")
            if not raw_len:
                return
            length = min(int(raw_len), MAX_BODY_BYTES)
            if length <= 0:
                return
            orig_timeout = None
            try:
                if hasattr(self.connection, "gettimeout"):
                    orig_timeout = self.connection.gettimeout()
                    self.connection.settimeout(0.05)
                self.rfile.read(length)
            except (TimeoutError, OSError):
                pass
            finally:
                if orig_timeout is not None and hasattr(self.connection, "settimeout"):
                    try:
                        self.connection.settimeout(orig_timeout)
                    except Exception:
                        pass
        except Exception:
            pass

    def _send_cors_headers(self):
        origin = (self.headers.get("Origin") or "").strip()
        if "\r" not in origin and "\n" not in origin and _is_allowed_origin(origin):
            try:
                parts = urllib.parse.urlsplit(origin)
                # Rebuild from constants + parsed parts so no raw request text is reflected.
                host = {"127.0.0.1": "127.0.0.1", "localhost": "localhost", "::1": "[::1]"}[(parts.hostname or "").lower()]
                port = f":{int(parts.port)}" if parts.port else ""
                safe_origin = f"{parts.scheme}://{host}{port}"
            except ValueError:
                return
            self.send_header("Access-Control-Allow-Origin", safe_origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-webhook-token")
            self.send_header("Vary", "Origin")

    def _send_json(self, status_code: int, data: Any):
        payload = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        if status_code >= 400:
            self.send_header("Connection", "close")
            self.close_connection = True
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(payload)
        try:
            self.wfile.flush()
        except Exception:
            pass
        if status_code >= 400:
            self._drain_best_effort()

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    # --- Auth -----------------------------------------------------------------
    def _is_authorized(self) -> bool:
        """
        When TRIAD_SERVER_TOKEN is set, every POST (and the sensitive GET /telemetry,
        GET /doctor) must present it as ``Authorization: Bearer <token>`` or
        ``x-webhook-token: <token>``. With no token configured the server stays open,
        preserving the original loopback-only trust model.
        """
        if not SERVER_TOKEN:
            return True
        presented = ""
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            presented = auth[7:].strip()
        if not presented:
            presented = (self.headers.get("x-webhook-token") or "").strip()
        return bool(presented) and hmac.compare_digest(presented.encode("utf-8"), SERVER_TOKEN.encode("utf-8"))

    def _require_auth(self, require_token_configured: bool = False) -> bool:
        if require_token_configured and not SERVER_TOKEN:
            self._send_json(401, {
                "error": "Unauthorized: TRIAD_SERVER_TOKEN must be configured on server to allow this sensitive endpoint",
                "hint": "Set TRIAD_SERVER_TOKEN in server environment"
            })
            return False
        if self._is_authorized():
            return True
        self._send_json(401, {"error": "Unauthorized", "hint": "Set Authorization: Bearer <TRIAD_SERVER_TOKEN>"})
        return False

    def _validate_host(self) -> bool:
        host = self.headers.get("Host", "").strip()
        if not host:
            return True
        if host.startswith("["):
            end_bracket = host.find("]")
            host_name = host[1:end_bracket].lower() if end_bracket != -1 else host.lower()
        else:
            host_name = host.rpartition(":")[0].lower() or host.lower()
        if host_name not in ("localhost", "127.0.0.1", "::1"):
            self._send_json(403, {"error": f"Forbidden Host: {host}"})
            return False
        return True

    # --- GET ------------------------------------------------------------------
    def do_GET(self):
        if not self._validate_host():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query_params = urllib.parse.parse_qs(parsed.query)

        if path in ("/", "/health"):
            resp = {
                "status": "ok",
                "service": "autonomous-triad",
                "version": TRIAD_VERSION,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "auth_required": bool(SERVER_TOKEN),
                "advisors": _public_advisors(),
                "subsystems": _subsystem_status(),
                "circuits": _public_circuits(),
            }
            self._send_json(200, resp)
            return

        if path == "/telemetry":
            if not self._require_auth(require_token_configured=True):
                return
            limit_val = 50
            if "limit" in query_params:
                try:
                    limit_val = max(1, min(500, int(query_params["limit"][0])))
                except ValueError:
                    pass
            self._send_json(200, get_telemetry_summary(limit=limit_val))
            return

        if path == "/doctor":
            probe = query_params.get("probe", ["0"])[0] in ("1", "true", "yes")
            if not self._require_auth(require_token_configured=True):
                return
            try:
                try:
                    from triad.triad_engine import collect_doctor_report
                except ImportError:
                    from triad_engine import collect_doctor_report
                self._send_json(200, collect_doctor_report(probe_advisors=probe))
            except Exception as e:
                self._send_json(500, {"error": f"doctor failed: {e}"})
            return

        self._send_json(404, {"error": "Not Found", "path": path})

    # --- POST -----------------------------------------------------------------
    def _read_json_body(self) -> Optional[Dict[str, Any]]:
        """Parse the JSON body defensively; sends the error response itself and returns None on failure."""
        if not self._validate_host():
            return None
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("application/json"):
            self._send_json(415, {"error": "Unsupported Media Type: Content-Type must be application/json"})
            return None
        raw_len = self.headers.get("Content-Length", "")
        try:
            content_len = int(raw_len or 0)
        except ValueError:
            self._send_json(400, {"error": "Invalid Content-Length header"})
            return None
        if content_len <= 0:
            self._send_json(400, {"error": "Empty or missing request body"})
            return None
        if content_len > MAX_BODY_BYTES:
            self._send_json(413, {"error": f"Request body exceeds {MAX_BODY_BYTES} bytes"})
            return None

        orig_timeout = None
        try:
            if hasattr(self.connection, "gettimeout"):
                orig_timeout = self.connection.gettimeout()
                self.connection.settimeout(10.0)
            body_raw = self.rfile.read(content_len).decode("utf-8", errors="replace")
        except (TimeoutError, OSError) as e:
            self._send_json(408, {"error": f"Request body read timed out: {e}"})
            return None
        finally:
            if orig_timeout is not None and hasattr(self.connection, "settimeout"):
                try:
                    self.connection.settimeout(orig_timeout)
                except Exception:
                    pass

        try:
            body = json.loads(body_raw)
        except Exception as e:
            self._send_json(400, {"error": f"Invalid JSON body: {e}"})
            return None
        if not isinstance(body, dict):
            self._send_json(400, {"error": "JSON body must be an object"})
            return None
        return body

    def _is_loopback(self) -> bool:
        host = self.client_address[0] if self.client_address else ""
        return host in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def _handle_delegate(self, body: Dict[str, Any]):
        if body.get("v") != 1 or body.get("to") != "autonomous-triad":
            self._send_json(400, {"error": "envelope is not addressed to autonomous-triad"})
            return
        envelope_id = body.get("id", "")
        sender = body.get("from", "")
        action = body.get("action", "")
        capability = body.get("capability", "")
        payload = body.get("payload") or {}

        if action == "ping":
            self._send_json(200, {
                "v": 1,
                "inReplyTo": envelope_id,
                "from": "autonomous-triad",
                "to": sender,
                "ok": True,
                "result": {
                    "status": "ok",
                    "service": "autonomous-triad",
                    "node": "autonomous-triad",
                    "host": "lubuntu",
                    "action": "ping"
                }
            })
            return

        if action == "classify":
            raw_text = str(payload.get("text") or payload.get("prompt") or "").strip()
            effective_text = raw_text or "status"
            context = str(payload.get("context") or "")
            diff = str(payload.get("diff") or "")
            classification = classify_intent(effective_text, context=context, diff=diff)
            risk_level, approval_required, risk_reasons = _evaluate_action_risk(classification, effective_text, context, diff)
            # Advisory classification: requires_biometric guides clients to solicit local
            # biometric authentication before submitting approval for high-risk / device-actuation actions.
            reasons_set = {str(r) for r in (risk_reasons if isinstance(risk_reasons, (list, tuple, set)) else [risk_reasons])}
            requires_biometric = (risk_level == "high") or ("device_actuation" in reasons_set)
            res_dict = {
                "intent": classification.intent,
                "mode": getattr(classification, "suggested_mode", None),
                "confidence": classification.confidence,
                "reason": classification.reason,
                "suggested_engine": classification.suggested_engine,
                "suggested_mode": classification.suggested_mode,
                "high_stakes": bool(getattr(classification, "high_stakes", True)),
                "risk_level": risk_level,
                "approval_required": approval_required,
                "requires_biometric": requires_biometric,
                "risk_reasons": risk_reasons,
            }
            if hasattr(classification, "__dict__"):
                for k, v in classification.__dict__.items():
                    if k not in res_dict and isinstance(v, (str, int, float, bool, type(None))):
                        res_dict[k] = v

            self._send_json(200, {
                "v": 1,
                "inReplyTo": envelope_id,
                "from": "autonomous-triad",
                "to": sender,
                "ok": True,
                "result": res_dict,
            })
            return

        if action == "approve":
            if SERVER_TOKEN and not self._is_authorized():
                self._send_json(401, {
                    "v": 1,
                    "inReplyTo": envelope_id,
                    "from": "autonomous-triad",
                    "to": sender,
                    "ok": False,
                    "error": "Unauthorized: sensitive action requires valid TRIAD_SERVER_TOKEN",
                })
                return
            proposal_id = str(payload.get("proposal_id") or payload.get("proposalId") or "").strip()
            nonce = str(payload.get("nonce") or payload.get("approval_nonce") or payload.get("approvalNonce") or "").strip()
            reason = str(payload.get("reason") or "Approved via Mobile 1-Tap Bridge").strip()
            attestation = payload.get("biometric_attestation")
            if not proposal_id or not nonce:
                self._send_json(400, {
                    "v": 1,
                    "inReplyTo": envelope_id,
                    "from": "autonomous-triad",
                    "to": sender,
                    "ok": False,
                    "error": "proposal approval requires proposal_id and nonce",
                })
                return
            status_code, resp_data = self._approve_proposal_flow(proposal_id, nonce, reason, attestation)
            env_resp = {
                "v": 1,
                "inReplyTo": envelope_id,
                "from": "autonomous-triad",
                "to": sender,
            }
            env_resp.update(resp_data)
            self._send_json(status_code, env_resp)
            return

        if action == "reject":
            if SERVER_TOKEN and not self._is_authorized():
                self._send_json(401, {
                    "v": 1,
                    "inReplyTo": envelope_id,
                    "from": "autonomous-triad",
                    "to": sender,
                    "ok": False,
                    "error": "Unauthorized: sensitive action requires valid TRIAD_SERVER_TOKEN",
                })
                return
            proposal_id = str(payload.get("proposal_id") or payload.get("proposalId") or "").strip()
            reason = str(payload.get("reason") or "Rejected via Mobile 1-Tap Bridge").strip()
            if not proposal_id:
                self._send_json(400, {
                    "v": 1,
                    "inReplyTo": envelope_id,
                    "from": "autonomous-triad",
                    "to": sender,
                    "ok": False,
                    "error": "proposal rejection requires proposal_id",
                })
                return
            status_code, resp_data = self._reject_proposal_flow(proposal_id, reason)
            env_resp = {
                "v": 1,
                "inReplyTo": envelope_id,
                "from": "autonomous-triad",
                "to": sender,
            }
            env_resp.update(resp_data)
            self._send_json(status_code, env_resp)
            return

        self._send_json(400, {
            "v": 1,
            "inReplyTo": envelope_id,
            "from": "autonomous-triad",
            "to": sender,
            "ok": False,
            "error": f"Unknown mishmash action: {action}"
        })

    _handle_mishmash_delegate = _handle_delegate

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/mishmash/delegate":
            if not self._is_loopback():
                self._send_json(403, {"error": "delegate is only accepted from this PC"})
                return
            body = self._read_json_body()
            if body is None:
                return
            try:
                self._handle_delegate(body)
            except Exception as e:
                self._send_json(500, {"error": f"Internal error: {e}"})
            return

        if path not in ("/auto", "/review", "/action/approve", "/action/reject"):
            self._send_json(404, {"error": "Not Found", "path": path})
            return
        if path.startswith("/action/"):
            if not self._require_auth(require_token_configured=True):
                return
        else:
            if not self._require_auth():
                return

        body = self._read_json_body()
        if body is None:
            return

        try:
            if path == "/auto":
                self._handle_auto(body)
            elif path == "/review":
                self._handle_review(body)
            elif path == "/action/approve":
                self._handle_action_approve(body)
            elif path == "/action/reject":
                self._handle_action_reject(body)
        except Exception as e:
            self._send_json(500, {"error": f"Internal error: {e}"})

    def _approve_proposal_flow(self, proposal_id: str, nonce: str, reason: str, biometric_attestation: Optional[str] = None) -> Tuple[int, Dict[str, Any]]:
        """Validate format, execute upstream release via _registry_call, and construct standardized response."""
        if not _ID_RE.fullmatch(proposal_id):
            return 400, {"ok": False, "error": "Invalid proposal_id format (must be 1-128 chars alphanumeric/-/_)"}
        if not _ID_RE.fullmatch(nonce):
            return 400, {"ok": False, "error": "Invalid nonce format (must be 1-128 chars alphanumeric/-/_)"}
        if biometric_attestation is not None:
            if not isinstance(biometric_attestation, str) or not biometric_attestation.strip():
                return 400, {"ok": False, "error": "Invalid biometric_attestation (must be non-empty string <= 4096 UTF-8 bytes)"}
            if len(biometric_attestation) > 4096:
                return 400, {"ok": False, "error": "Invalid biometric_attestation (must be non-empty string <= 4096 UTF-8 bytes)"}
            try:
                att_bytes = biometric_attestation.encode("utf-8")
            except UnicodeEncodeError:
                return 400, {"ok": False, "error": "Invalid biometric_attestation (must be non-empty string <= 4096 UTF-8 bytes)"}
            if len(att_bytes) > 4096:
                return 400, {"ok": False, "error": "Invalid biometric_attestation (must be non-empty string <= 4096 UTF-8 bytes)"}

        clean_reason = str(reason or "Approved via Mobile 1-Tap Bridge")[:500]

        call_status, call_detail = _registry_call("release", {
            "proposalId": proposal_id,
            "nonce": nonce,
            "reason": clean_reason,
            "biometric_attestation": biometric_attestation,
        }, timeout=3.0)

        if call_status == "ok":
            return 200, {
                "ok": True,
                "status": "approved",
                "action": "approve",
                "proposal_id": proposal_id,
                "reason": clean_reason,
                "release": call_detail,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        if call_status == "http":
            if call_detail >= 500:
                logger.warning("Upstream release server error HTTP %r for proposal %r", call_detail, proposal_id)
                return 504, {
                    "ok": False,
                    "status": "release_unknown",
                    "proposal_id": proposal_id,
                    "upstream_status": call_detail,
                    "error": f"Upstream returned HTTP {call_detail}; release state unconfirmed",
                }
            mapped_code = 409 if call_detail in (401, 403, 409, 410) else (call_detail if call_detail == 404 else 502)
            logger.warning("Upstream release rejected with HTTP %r for proposal %r", call_detail, proposal_id)
            return mapped_code, {
                "ok": False,
                "status": "release_failed",
                "proposal_id": proposal_id,
                "upstream_status": call_detail,
                "error": f"Upstream rejected release with HTTP {call_detail}",
            }
        if call_status == "unknown":
            logger.warning("Upstream release timeout or malformed body for proposal %r: %r", proposal_id, call_detail)
            return 504, {
                "ok": False,
                "status": "release_unknown",
                "proposal_id": proposal_id,
                "error": "Upstream timed out or returned malformed response; release state unconfirmed",
            }
        if call_status == "rejected":
            return 409, {
                "ok": False,
                "status": "release_rejected",
                "proposal_id": proposal_id,
                "release": call_detail,
                "error": "Upstream release did not indicate success",
            }
        # unreachable
        logger.warning("Upstream release unreachable for proposal %r: %r", proposal_id, call_detail)
        return 502, {
            "ok": False,
            "status": "release_failed",
            "proposal_id": proposal_id,
            "error": "Upstream unreachable or unresponsive",
        }

    def _reject_proposal_flow(self, proposal_id: str, reason: str) -> Tuple[int, Dict[str, Any]]:
        """Validate format, execute upstream rejection via _registry_call, and construct standardized response."""
        if not _ID_RE.fullmatch(proposal_id):
            return 400, {"ok": False, "error": "Invalid proposal_id format (must be 1-128 chars alphanumeric/-/_)"}

        clean_reason = str(reason or "Rejected via Mobile 1-Tap Bridge")[:500]

        call_status, call_detail = _registry_call("reject", {
            "proposalId": proposal_id,
            "reason": clean_reason,
        }, timeout=2.0)

        if call_status == "ok":
            return 200, {
                "ok": True,
                "status": "rejected",
                "action": "reject",
                "proposal_id": proposal_id,
                "upstream_notified": True,
                "reason": clean_reason,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        if call_status == "unknown":
            logger.warning("Upstream reject timeout for proposal %r: %r", proposal_id, call_detail)
            return 504, {
                "ok": False,
                "status": "reject_unconfirmed",
                "proposal_id": proposal_id,
                "upstream_notified": False,
                "error": "Upstream timed out during proposal rejection",
            }
        logger.warning("Upstream reject failed (%r) for proposal %r: %r", call_status, proposal_id, call_detail)
        return 502, {
            "ok": False,
            "status": "reject_unconfirmed",
            "proposal_id": proposal_id,
            "upstream_notified": False,
            "upstream_status": call_detail if call_status == "http" else None,
            "error": f"Upstream failed to confirm rejection ({call_status})",
        }

    def _handle_action_approve(self, body: Dict[str, Any]):
        reason = str(body.get("reason", "Approved via Mobile 1-Tap Bridge"))[:500]
        proposal_id = str(body.get("proposal_id") or body.get("proposalId") or "").strip()
        patch_file = body.get("patch_file", "")

        if proposal_id and patch_file:
            self._send_json(400, {"error": "cannot provide both proposal_id and patch_file"})
            return

        if proposal_id:
            nonce = str(body.get("nonce") or body.get("approval_nonce") or body.get("approvalNonce") or "").strip()
            if not nonce:
                self._send_json(400, {"error": "proposal approval requires nonce"})
                return
            attestation = body.get("biometric_attestation")
            status_code, resp_data = self._approve_proposal_flow(proposal_id, nonce, reason, attestation)
            self._send_json(status_code, resp_data)
            return

        repo_arg = body.get("repo_path", "")

        try:
            repo_dir = _resolve_repo_path(repo_arg)
        except RepoNotAllowed as denied:
            self._send_json(403, {
                "error": "repo not in TRIAD_ALLOWED_REPOS",
                "repo_path": denied.repo_path
            })
            return
        if not repo_dir:
            self._send_json(400, {
                "error": "Target repository path is not a valid git repository",
                "repo_path": repo_arg or str(Path.cwd())
            })
            return

        applied = False
        if patch_file:
            safe_patch = _safe_patch_path(patch_file)
            if not safe_patch:
                self._send_json(400, {
                    "error": "Invalid patch_file: must be an existing file within allowed patch directory"
                })
                return

            patch_sha256 = str(body.get("patch_sha256", "")).strip()
            if not patch_sha256:
                self._send_json(400, {
                    "error": "patch_sha256 required"
                })
                return

            try:
                patch_bytes = safe_patch.read_bytes()
            except Exception as e:
                self._send_json(400, {"error": f"Failed reading patch file: {e}"})
                return

            actual_sha = hashlib.sha256(patch_bytes).hexdigest()
            if not hmac.compare_digest(actual_sha.lower(), patch_sha256.lower()):
                self._send_json(409, {
                    "status": "conflict",
                    "error": f"Patch SHA256 digest mismatch (expected {patch_sha256}, got {actual_sha})"
                })
                return

            repo_lock = _get_repo_lock(repo_dir)
            with repo_lock:
                try:
                    ret_check = subprocess.run(
                        ["git", "apply", "--check", "--whitespace=nowarn", "-"],
                        input=patch_bytes,
                        cwd=str(repo_dir),
                        env=clean_git_env(),
                        capture_output=True,
                        timeout=15
                    )
                    if ret_check.returncode != 0:
                        err_detail = ret_check.stderr.decode("utf-8", errors="replace").strip() or ret_check.stdout.decode("utf-8", errors="replace").strip()
                        self._send_json(409, {
                            "status": "conflict",
                            "error": "Patch does not apply cleanly to target repository",
                            "details": err_detail
                        })
                        return
                except Exception as e:
                    self._send_json(500, {"error": f"Failed checking patch: {e}"})
                    return

                try:
                    ret_apply = subprocess.run(
                        ["git", "apply", "--whitespace=nowarn", "-"],
                        input=patch_bytes,
                        cwd=str(repo_dir),
                        env=clean_git_env(),
                        capture_output=True,
                        timeout=15
                    )
                    if ret_apply.returncode != 0:
                        err_detail = ret_apply.stderr.decode("utf-8", errors="replace").strip() or ret_apply.stdout.decode("utf-8", errors="replace").strip()
                        self._send_json(409, {
                            "status": "conflict",
                            "error": "Failed applying patch to target repository",
                            "details": err_detail
                        })
                        return
                    applied = True
                except Exception as e:
                    self._send_json(500, {"error": f"Failed applying patch: {e}"})
                    return

        self._send_json(200, {
            "status": "approved",
            "action": "approve",
            "patch_applied": applied,
            "repo_path": str(repo_dir),
            "reason": reason,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        })

    def _handle_action_reject(self, body: Dict[str, Any]):
        reason = str(body.get("reason", "Rejected via Mobile 1-Tap Bridge"))[:500]
        proposal_id = str(body.get("proposal_id") or body.get("proposalId") or "").strip()
        if proposal_id:
            status_code, resp_data = self._reject_proposal_flow(proposal_id, reason)
            self._send_json(status_code, resp_data)
            return

        self._send_json(200, {
            "status": "rejected",
            "action": "reject",
            "reason": reason,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })

    def _handle_auto(self, body: Dict[str, Any]):
        prompt = str(body.get("prompt", "")).strip()
        context = body.get("context", "")
        diff = body.get("diff", "")
        force_competition = bool(body.get("competition", False))
        use_worktree = bool(body.get("worktree", False))

        if not prompt and not diff:
            self._send_json(400, {"error": "Prompt or diff is required"})
            return

        classification = classify_intent(prompt, context=context, diff=diff)
        if force_competition:
            classification.suggested_engine = "competition"

        # os.chdir is process-global and this server is multi-threaded, so a worktree
        # cannot be entered safely here. The CLI (`triad auto --worktree`) does the
        # isolation in its own process. Pretending on HTTP ran the request in the
        # parent checkout.
        if use_worktree:
            self._send_json(501, {
                "error": "worktree isolation is not available on POST /auto. Use `triad auto --worktree` locally.",
                "intent": classification.intent,
            })
            return

        result = self._execute_remote_intent(classification, prompt, context, diff)

        self._send_json(200, {
            "status": "success",
            "intent": classification.intent,
            "confidence": classification.confidence,
            "reason": classification.reason,
            "suggested_mode": classification.suggested_mode,
            "suggested_engine": classification.suggested_engine,
            "high_stakes": classification.high_stakes,
            "result": result,
        })

    def _execute_remote_intent(self, classification, prompt: str, context: str, diff: str) -> Any:
        intent = classification.intent
        engine = classification.suggested_engine

        if intent == "REVIEW":
            if engine == "competition":
                session = query_competition_council(prompt or "Review this diff", context=context, diff=diff, mode="review_diff")
                return {"synthesis": session["synthesis"], "advisors": session["advisors"]}
            resp = query_configured_advisor("auto", prompt or "Review this diff", context=context, diff=diff, mode="review_diff")
            return {"response": resp}

        if intent in ("ARCHITECT", "GENERAL", "MICRO"):
            if engine == "competition":
                session = query_competition_council(prompt, context=context, mode="architect")
                return {"synthesis": session["synthesis"], "advisors": session["advisors"]}
            if (intent == "MICRO" or engine == "ollama") and is_port_open("127.0.0.1", PORT_OLLAMA, timeout=0.3):
                resp = query_configured_advisor("ollama", prompt, context=context, mode="general")
                return {"response": resp}
            resp = query_configured_advisor("auto", prompt, context=context, mode="architect")
            return {"response": resp}

        if intent == "DEBUG":
            if engine == "competition":
                session = query_competition_council(prompt, context=context, mode="debug")
                return {"synthesis": session["synthesis"], "advisors": session["advisors"]}
            resp = query_configured_advisor("auto", prompt, context=context, mode="debug")
            return {"response": resp}

        if intent == "DOCTOR":
            status = _subsystem_status()
            status["advisors"] = _public_advisors()
            return status

        if intent == "DEVICE":
            bridge_alive = is_port_open("127.0.0.1", PORT_HERMES_RELAY, timeout=0.5)
            return {
                "bridge_online": bridge_alive,
                "port": PORT_HERMES_RELAY,
                "status": "ready" if bridge_alive else "standby",
                "message": "Android relay connected" if bridge_alive else "Dial phone app com.hermesandroid.bridge",
            }

        if intent == "MEMORY":
            return {
                "pieces_os_online": is_port_open("127.0.0.1", PORT_PIECES_OS, timeout=0.5),
                "mem0_configured": MEM0_SCRIPT.exists(),
                "query": prompt,
            }

        return {"message": f"Intent {intent} received"}

    def _handle_review(self, body: Dict[str, Any]):
        prompt = str(body.get("prompt", "")).strip() or "Review this diff"
        diff = str(body.get("diff", "")).strip()
        context = str(body.get("context", "")).strip()
        competition = bool(body.get("competition", False))
        engine = str(body.get("engine", "auto"))

        if not diff:
            self._send_json(400, {"error": "Diff content is required for /review"})
            return

        if competition:
            session = query_competition_council(prompt, context=context, diff=diff, mode="review_diff")
            self._send_json(200, {
                "status": "success",
                "mode": "competition",
                "synthesis": session["synthesis"],
                "advisors": session["advisors"],
                "elapsed_seconds": session["elapsed_seconds"],
            })
        else:
            resp = query_configured_advisor(engine, prompt, context=context, diff=diff, mode="review_diff")
            self._send_json(200, {
                "status": "success",
                "mode": "single",
                "engine": engine,
                "response": resp,
            })

    def log_message(self, format, *args):
        # Override standard logging to provide clean one-line Triad server logs
        print(f"[Triad Server] {self.address_string()} - {format % args}")


def start_server(host: str = "127.0.0.1", port: int = 8789) -> None:
    """Start Triad Ambient HTTP server listening until interrupted."""
    server_address = (host, port)
    try:
        httpd = ThreadingHTTPServer(server_address, TriadRequestHandler)
    except OSError as e:
        print(f"[Triad Server Error] Could not bind to {host}:{port}: {e}", file=sys.stderr)
        sys.exit(1)

    print("================================================================================")
    print("           AUTONOMOUS MULTI-AGENT TRIAD: AMBIENT HTTP BRIDGE                    ")
    print("================================================================================")
    print(f"Listening on http://{host}:{port}")
    print(f"Auth: {'bearer token required (TRIAD_SERVER_TOKEN)' if SERVER_TOKEN else 'open (set TRIAD_SERVER_TOKEN to require a bearer token)'}")
    print("Endpoints:")
    print("  - GET  /health      System health, subsystem connectivity, and advisor status")
    print("  - GET  /doctor      Full structured doctor report (?probe=1 for a live Claude probe)")
    print("  - GET  /telemetry   Council adjudication history & per-advisor call stats")
    print("  - POST /auto        Sub-millisecond intent classification & autonomous execution")
    print("  - POST /review      Diff review and dual-advisor competition consensus")
    print("Press Ctrl+C to terminate.")
    print("================================================================================\n")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[Triad Server] Shutting down...")
    finally:
        httpd.server_close()
        print("[Triad Server] Stopped.")


if __name__ == "__main__":
    start_server(port=PORT_TRIAD_SERVER)
