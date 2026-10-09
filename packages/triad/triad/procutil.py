"""
Autonomous Multi-Agent Triad: Process & Network Utilities (procutil.py).

Cross-platform helpers shared by the engine, advisor manager, and HTTP server.
Previously each module carried its own copy of these; this is the single
implementation.
"""

from __future__ import annotations

import os
import re
import signal
import socket
import subprocess
from typing import Optional

try:  # psutil is optional; we degrade to OS primitives without it.
    import psutil  # type: ignore
except Exception:  # pragma: no cover - exercised only when psutil is absent
    psutil = None  # type: ignore


def clean_git_env(extra_env: Optional[dict] = None, *, base_env: Optional[dict] = None) -> dict:
    """Return an environment dictionary sanitized of local Git environment variables."""
    try:
        from triad.worktree import clean_git_env as _clean
    except ImportError:
        from worktree import clean_git_env as _clean
    return _clean(extra_env=extra_env, base_env=base_env)


def kill_process_tree(pid: int, timeout: float = 5.0) -> None:
    """
    Force-terminate ``pid`` and every descendant.

    Strategy (best-effort, never raises):
      1. psutil, if installed - walks the tree and kills children first.
      2. Windows: ``taskkill /F /T``.
      3. POSIX: SIGKILL the process group if the pid leads one, else the pid.
    """
    if pid is None or pid <= 0:
        return

    if psutil is not None:
        try:
            parent = psutil.Process(pid)
            children = parent.children(recursive=True)
            for child in children:
                try:
                    child.kill()
                except Exception:
                    pass
            try:
                parent.kill()
            except Exception:
                pass
            try:
                psutil.wait_procs(children + [parent], timeout=timeout)
            except Exception:
                pass
            return
        except getattr(psutil, "NoSuchProcess", Exception):
            return
        except Exception:
            pass

    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=timeout,
            )
        except Exception:
            pass
        return

    # POSIX fallback
    try:
        pgid = os.getpgid(pid)
        if pgid == pid:
            os.killpg(pgid, signal.SIGKILL)
            return
    except Exception:
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass


def is_port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    """Quick TCP connect probe with guaranteed socket cleanup."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def classify_advisor_response(text: Optional[str]) -> str:
    """
    Classify a raw advisor response string into one of:
      ``"ok"``      - a usable answer
      ``"limit"``   - the advisor reported a session / rate / usage limit
      ``"error"``   - the advisor failed for any other reason
      ``"empty"``   - nothing came back

    Only the *leading bracketed tag* is inspected (e.g. ``[Claude Session Limit]: ...``),
    so an otherwise-valid review that merely mentions the word "limit" in its body is
    never misclassified as a failure.
    """
    s = (text or "").strip()
    if not s:
        return "empty"
    if not s.startswith("["):
        return "ok"
    close = s.find("]")
    if close == -1:
        return "ok"
    tag = s[1:close].lower()
    # A successful failover prefixes the *good* answer with a header that quotes the
    # earlier failures - that header must read as success, not as the failure it quotes.
    if tag.startswith("advisor auto-failover"):
        return "error" if "exhausted" in tag else "ok"
    if any(k in tag for k in ("session limit", "rate limit", "usage limit")):
        return "limit"
    if "triad circuit" in tag:
        return "limit" if any(k in tag for k in ("cooldown", "limit", "open")) else "error"
    if "timed out" in tag:
        return "timeout"
    if (
        tag in ("error", "failure", "failed")
        or tag.startswith(("error:", "failure:", "failed:", "error from ", "error calling ", "error in ", "failure from ", "error -", "error \u2013"))
        or (tag.startswith("competition") and ("fail" in tag or "error" in tag))
        or tag.startswith(("triad error", "advisor error"))
        or bool(re.search(r"\b(?:error|failure|failed)\s*:", tag))
        or bool(re.search(r"\b(?:error|failure|failed)$", tag))
    ):
        return "error"
    return "ok"


def is_failed_advisor_response(text: Optional[str]) -> bool:
    """True when ``text`` should trigger failover to the next advisor."""
    return classify_advisor_response(text) in ("limit", "error", "empty", "timeout")


LOCKFILE_NAMES = frozenset({
    "uv.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    "pipfile.lock",
    "poetry.lock",
    "cargo.lock",
    "go.sum",
    "composer.lock",
    "gemfile.lock",
    "mix.lock",
    "flake.lock",
    "packages.lock.json",
    "npm-shrinkwrap.json",
})

MINIFIED_EXTENSIONS = frozenset({
    ".min.js",
    ".min.css",
    ".bundle.js",
    ".bundle.css",
    ".map",
})

BINARY_ASSET_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg", ".bmp", ".tiff",
    ".pdf", ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".mp3", ".mp4", ".wav", ".ogg", ".webm",
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".whl", ".jar",
    ".iso", ".exe", ".dll", ".so", ".dylib", ".bin",
})

DOC_EXTENSIONS = frozenset({
    ".md", ".markdown", ".mdown", ".mkd",
    ".rst", ".adoc",
})

ASSET_EXTENSIONS = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svg", ".bmp", ".tiff",
    ".pdf", ".drawio",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".mp3", ".mp4", ".wav", ".ogg", ".webm",
})

NON_CODE_METADATA_FILES = frozenset({
    ".gitignore", ".gitattributes", ".editorconfig",
    "license", "licence", "notice", "authors", "contributors",
    "changelog", "readme",
})

CODE_OR_CONFIG_EXTENSIONS = frozenset({
    ".py", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1",
    ".c", ".h", ".cpp", ".hpp", ".rs", ".go", ".java", ".kt", ".swift",
    ".html", ".css", ".scss", ".less", ".sql", ".graphql", ".proto",
})

_MARKER_RE = re.compile(r"(?m)^\[(?:Diff omitted: |\.\.\. \d+ lines truncated)")


def is_doc_or_asset_file(path_str: str) -> bool:
    """Return True if path_str is strictly a documentation or non-code asset file."""
    if not path_str:
        return False
    p = path_str.replace("\\", "/").lower().strip()
    base = os.path.basename(p)
    parts = [seg for seg in p.split("/") if seg]

    # Test suites, benchmarks, and test fixtures are NEVER classified as doc/asset files
    if any(seg in ("tests", "test", "fixtures", "fixture", "cases") for seg in parts):
        return False

    # Package management, dependency specifications, and build files are code/config
    if base.startswith("requirements") and base.endswith(".txt"):
        return False
    if base in ("cmakelists.txt", "dockerfile", "makefile", "procfile", "gemfile", "vagrantfile"):
        return False

    # Standard non-code root metadata files
    if base in NON_CODE_METADATA_FILES:
        return True
    root_name, ext = os.path.splitext(base)
    if root_name in NON_CODE_METADATA_FILES and ext in (".md", ".txt", ".rst", ""):
        return True

    # Any file with code/configuration extensions must always be treated as code
    if ext in CODE_OR_CONFIG_EXTENSIONS:
        return False

    # Pure documentation and static visual assets
    if ext in DOC_EXTENSIONS or ext in ASSET_EXTENSIONS:
        return True

    # Dedicated documentation directories (e.g. docs/, doc/) containing docs/assets/txt
    if parts and parts[0] in ("docs", "doc"):
        if ext in DOC_EXTENSIONS or ext in ASSET_EXTENSIONS or ext in (".txt", ""):
            return True

    # Plain text files that are explicitly documentation or notes
    if ext == ".txt" and (base.startswith(("readme", "license", "notes", "changelog", "install", "authors"))):
        return True

    return False


def _path_from_diff_git_header(first_line: str) -> str:
    """Extract the file path from a ``diff --git`` header using string ops (no regex backtracking)."""
    prefix = "diff --git"
    if not first_line.startswith(prefix) or len(first_line) == len(prefix) or not first_line[len(prefix)].isspace():
        return ""
    rest = first_line[len(prefix):].strip()
    # Quoted/prefixed form: a/<old> b/<new>, optionally with each side quoted.
    unquoted = rest.lstrip('"')
    if unquoted.startswith("a/"):
        body = unquoted[2:]
        cuts = [(body.find(sep), sep) for sep in (' "b/', " b/")]
        cuts = [(i, sep) for i, sep in cuts if i >= 0]
        if cuts:
            idx, sep = min(cuts)
            old, new = body[:idx], body[idx + len(sep):]
            return new.rstrip('"') or old.rstrip('"')
    # Fallback: split on the first whitespace run, dropping optional a/ b/ prefixes.
    parts = rest.split(None, 1)
    if len(parts) < 2:
        return ""
    old, new = parts
    old = old.removeprefix("a/")
    new = new.removeprefix("b/")
    return new or old


def strip_diff_bloat(diff_text: Optional[str], max_lines_per_file: int = 500) -> str:
    """
    Sanitize git diff text before passing to LLM advisors.

    Strips massive lockfiles, minified bundles, and binary assets while
    preserving the diff headers (so the LLM is aware which files changed).
    Truncates abnormally large single-file diffs to protect context limits.
    Guaranteed strictly idempotent across single and multi-file diffs.
    """
    if not diff_text or not diff_text.strip():
        return ""

    file_chunks = re.split(r"(?m)(?=^diff --git )", diff_text)
    sanitized_chunks = []

    for chunk in file_chunks:
        chunk_clean = chunk.rstrip("\n")
        if not chunk_clean.strip():
            continue

        # If this chunk already contains an anchored Triad sanitization marker line, preserve it (idempotency)
        if _MARKER_RE.search(chunk_clean):
            sanitized_chunks.append(chunk_clean)
            continue

        lines = chunk_clean.splitlines()
        first_line = lines[0][:2048] if lines else ""  # bound input to the header regexes below

        # Robustly extract file path preferring +++ b/ or --- a/ over diff --git (supports spaces & quotes)
        file_path = ""
        for line in lines[:10]:
            if line.startswith("+++ b/"):
                file_path = line[6:].strip().strip("\"'")
                break
            elif line.startswith("+++ ") and line != "+++ /dev/null":
                file_path = line[4:].strip().strip("\"'")
                break
            elif line.startswith("--- a/") and not file_path:
                file_path = line[6:].strip().strip("\"'")
            elif line.startswith("--- ") and line != "--- /dev/null" and not file_path:
                file_path = line[4:].strip().strip("\"'")

        if not file_path:
            file_path = _path_from_diff_git_header(first_line)

        clean_path = file_path.strip().strip("\"'")
        file_name = os.path.basename(clean_path).lower()

        is_lockfile = file_name in LOCKFILE_NAMES
        is_minified = any(file_name.endswith(m_ext) for m_ext in MINIFIED_EXTENSIONS)
        is_git_binary = bool(
            re.search(r"(?m)^Binary files .* differ$", chunk_clean)
            or re.search(r"(?m)^GIT binary patch", chunk_clean)
        )
        is_binary = any(file_name.endswith(b_ext) for b_ext in BINARY_ASSET_EXTENSIONS) or is_git_binary

        if is_lockfile or is_minified or is_binary:
            category = "lockfile update" if is_lockfile else ("binary / asset file" if is_binary else "minified / generated asset")

            header_lines = []
            hunk_line_count = 0
            in_header = True
            for line in lines:
                if in_header:
                    header_lines.append(line)
                    if line.startswith("+++ ") or line.startswith("Binary files ") or line.startswith("GIT binary patch"):
                        in_header = False
                else:
                    hunk_line_count += 1

            if hunk_line_count > 0 or is_git_binary:
                header_lines.append(f"[Diff omitted: {category} ({hunk_line_count} lines omitted to preserve LLM context)]")
                sanitized_chunks.append("\n".join(header_lines).rstrip("\n"))
            else:
                sanitized_chunks.append(chunk_clean)
            continue

        header_lines = []
        hunk_lines = []
        in_header = True
        for line in lines:
            if in_header:
                header_lines.append(line)
                if line.startswith("+++ "):
                    in_header = False
            else:
                hunk_lines.append(line)

        if len(hunk_lines) > max_lines_per_file:
            keep_count = max_lines_per_file
            truncated_count = len(hunk_lines) - keep_count
            kept_hunk = hunk_lines[:keep_count]
            kept_hunk.append(f"[... {truncated_count} lines truncated to protect LLM context ...]")
            sanitized_chunks.append("\n".join(header_lines + kept_hunk).rstrip("\n"))
        else:
            sanitized_chunks.append(chunk_clean)

    return "\n\n".join(sanitized_chunks)


__all__ = [
    "clean_git_env",
    "kill_process_tree",
    "is_port_open",
    "classify_advisor_response",
    "is_failed_advisor_response",
    "LOCKFILE_NAMES",
    "MINIFIED_EXTENSIONS",
    "BINARY_ASSET_EXTENSIONS",
    "DOC_EXTENSIONS",
    "ASSET_EXTENSIONS",
    "NON_CODE_METADATA_FILES",
    "CODE_OR_CONFIG_EXTENSIONS",
    "is_doc_or_asset_file",
    "strip_diff_bloat",
]
