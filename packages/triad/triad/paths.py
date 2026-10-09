"""
Autonomous Multi-Agent Triad: Portable Path Resolution (paths.py).

Single source of truth for every external binary, credential file, and helper
script the Triad touches. Resolution order for each path:

  1. Explicit environment override (e.g. ``TRIAD_CLAUDE_PATH``).
  2. The executable found on ``PATH`` via ``shutil.which`` (binaries only).
  3. A conventional per-user default under ``Path.home()``.

Nothing in this module may hardcode a specific user's home directory.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Iterable, Optional

HOME: Path = Path.home()
LOCAL_APPDATA: Path = Path(os.environ.get("LOCALAPPDATA", str(HOME / "AppData" / "Local")))


def expand_path(raw: str) -> str:
    """Expand ``~``, ``{home}``, ``{localappdata}`` and ``$ENV``/``%ENV%`` tokens in a path string."""
    if not raw:
        return raw
    expanded = raw.replace("{home}", str(HOME)).replace("{localappdata}", str(LOCAL_APPDATA))
    expanded = os.path.expandvars(expanded)
    return os.path.expanduser(expanded)


def _first_existing(candidates: Iterable[Path]) -> Optional[Path]:
    for c in candidates:
        try:
            if c.exists():
                return c
        except OSError:
            continue
    return None


def resolve_binary_path(env_var: str, command: str, *defaults: Path) -> Path:
    """
    Resolve an external CLI binary.

    ``env_var`` wins if set (even if the file does not exist yet, so the user's
    intent is preserved in diagnostics). Otherwise the command on ``PATH`` is
    preferred, then the conventional defaults. If nothing is found the first
    default is returned so callers can still print a meaningful path in ``doctor``.
    """
    override = os.environ.get(env_var, "").strip()
    if override:
        return Path(expand_path(override))

    which = shutil.which(command)
    if which:
        return Path(which)

    found = _first_existing(defaults)
    if found is not None:
        return found
    return defaults[0] if defaults else Path(command)


def resolve_file_path(env_var: str, default: Path) -> Path:
    """Resolve a non-executable file (credentials, helper scripts) with env override."""
    override = os.environ.get(env_var, "").strip()
    if override:
        return Path(expand_path(override))
    return default


# --- Advisory council binaries ------------------------------------------------
CLAUDE_PATH: Path = resolve_binary_path(
    "TRIAD_CLAUDE_PATH", "claude",
    HOME / ".local" / "bin" / "claude.exe",
    HOME / ".local" / "bin" / "claude",
)
CODEX_PATH: Path = resolve_binary_path(
    "TRIAD_CODEX_PATH", "codex",
    LOCAL_APPDATA / "Programs" / "OpenAI" / "Codex" / "bin" / "codex.exe",
    HOME / ".local" / "bin" / "codex",
)
AGY_PATH: Path = resolve_binary_path(
    "TRIAD_AGY_PATH", "agy",
    LOCAL_APPDATA / "agy" / "bin" / "agy.exe",
    HOME / ".local" / "bin" / "agy",
)
HERMES_PATH: Path = resolve_binary_path(
    "TRIAD_HERMES_PATH", "hermes",
    LOCAL_APPDATA / "hermes" / "bin" / "hermes.exe",
    HOME / ".local" / "bin" / "hermes",
)
OLLAMA_PATH: Path = resolve_binary_path(
    "TRIAD_OLLAMA_PATH", "ollama",
    LOCAL_APPDATA / "Programs" / "Ollama" / "ollama.exe",
    Path("/usr/local/bin/ollama"),
)

# --- Credentials & helper scripts --------------------------------------------
CODEX_AUTH: Path = resolve_file_path("TRIAD_CODEX_AUTH", HOME / ".codex" / "auth.json")
MEM0_SCRIPT: Path = resolve_file_path("TRIAD_MEM0_SCRIPT", HOME / ".agents" / "skills" / "mem0" / "mem0.js")
ANDROID_RELAY_ENV: Path = resolve_file_path("TRIAD_ANDROID_RELAY_ENV", HOME / "android-relay-env")

def _safe_int_env(var: str, default: int) -> int:
    try:
        val = os.environ.get(var, "").strip()
        return int(val) if val else default
    except (ValueError, TypeError):
        return default


# --- Well-known local ports ---------------------------------------------------
PORT_HERMES_RELAY = _safe_int_env("TRIAD_PORT_HERMES_RELAY", 8766)
PORT_PIECES_PROXY = _safe_int_env("TRIAD_PORT_PIECES_PROXY", 8787)
PORT_TRIAD_SERVER = _safe_int_env("TRIAD_PORT", 8789)
PORT_PIECES_OS = _safe_int_env("TRIAD_PORT_PIECES_OS", 39300)
PORT_OLLAMA = _safe_int_env("TRIAD_PORT_OLLAMA", 11434)

# --- Agent Mesh MCP -----------------------------------------------------------
AGENT_MESH_DIR: Path = resolve_file_path("TRIAD_AGENT_MESH_DIR", HOME / "projects" / "agent-mesh-mcp")
AGENT_MESH_SERVER: Path = resolve_file_path("TRIAD_AGENT_MESH_SERVER", AGENT_MESH_DIR / "dist" / "server.js")

__all__ = [
    "HOME", "LOCAL_APPDATA", "expand_path", "resolve_binary_path", "resolve_file_path",
    "CLAUDE_PATH", "CODEX_PATH", "AGY_PATH", "HERMES_PATH", "OLLAMA_PATH",
    "CODEX_AUTH", "MEM0_SCRIPT", "ANDROID_RELAY_ENV",
    "AGENT_MESH_DIR", "AGENT_MESH_SERVER",
    "PORT_HERMES_RELAY", "PORT_PIECES_PROXY", "PORT_TRIAD_SERVER", "PORT_PIECES_OS", "PORT_OLLAMA",
]
