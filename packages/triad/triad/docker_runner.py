#!/usr/bin/env python3
"""
docker_runner.py
Container-backed VerificationRunner for the Morphogenetic engine.

Runs a trusted, named verification profile against a candidate workspace inside a locked-down
container so repair candidates can no longer read host files, reach the network or see host secrets:

  - no network, no IPC namespace sharing, no host environment passed through
  - unprivileged uid, all capabilities dropped, no-new-privileges, read-only root filesystem
  - memory / CPU / process / file-descriptor limits (contains fork bombs and runaway tests)
  - only the throwaway workspace is mounted; nothing else from the host is visible
  - the container is killed (with every descendant) on timeout
  - images are never pulled at run time (``--pull never``); use ``ensure_image`` as an explicit step

Profiles are argv lists from trusted configuration, never taken from a candidate. They run inside
the image, so use image-relative commands (``python``, not ``sys.executable``).
"""

import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

DEFAULT_IMAGE = "python:3.12-slim"
_SAFE_ENV = {
    "PYTHONDONTWRITEBYTECODE": "1",
    "PYTHONIOENCODING": "utf-8",
    "PYTHONUTF8": "1",
    "HOME": "/tmp",
}


class IsolationUnavailable(RuntimeError):
    """The container runtime is missing or not running. Callers must treat this as a rejection."""


class DockerRunner:
    def __init__(
        self,
        profiles: Dict[str, List[str]],
        *,
        image: str = DEFAULT_IMAGE,
        memory: str = "1g",
        cpus: str = "2",
        pids_limit: int = 256,
        tmpfs_size: str = "64m",
        max_output_bytes: int = 64 * 1024,
        docker_bin: Optional[str] = None,
        runner: Callable[..., "subprocess.CompletedProcess[str]"] = subprocess.run,
    ):
        for name, argv in profiles.items():
            if not argv or not all(isinstance(a, str) and a for a in argv):
                raise ValueError(f"profile {name!r} must be a non-empty list of non-empty strings")
        self._profiles = {name: list(argv) for name, argv in profiles.items()}
        self.image = image
        self.memory = memory
        self.cpus = cpus
        self.pids_limit = pids_limit
        self.tmpfs_size = tmpfs_size
        self.max_output_bytes = max_output_bytes
        self._docker = docker_bin or shutil.which("docker") or "docker"
        self._run = runner
        self._checked: Optional[Tuple[bool, str]] = None

    # -- runtime checks -------------------------------------------------------------------------

    def available(self, refresh: bool = False) -> Tuple[bool, str]:
        """(ok, reason). Cheap daemon ping; cached after the first success."""
        if self._checked and self._checked[0] and not refresh:
            return self._checked
        try:
            res = self._run(
                [self._docker, "info", "--format", "{{.ServerVersion}}"],
                capture_output=True, text=True, timeout=20,
            )
            ok = res.returncode == 0 and bool(res.stdout.strip())
            reason = "ok" if ok else (res.stderr.strip().splitlines() or ["docker daemon not reachable"])[-1]
        except (OSError, subprocess.SubprocessError) as e:
            ok, reason = False, f"docker not usable: {e}"
        self._checked = (ok, reason)
        return self._checked

    def ensure_image(self, timeout: int = 600) -> None:
        """Explicit, host-side step: make sure the image exists locally (pulls if missing)."""
        ok, reason = self.available()
        if not ok:
            raise IsolationUnavailable(reason)
        have = self._run([self._docker, "image", "inspect", self.image], capture_output=True, text=True, timeout=30)
        if have.returncode == 0:
            return
        pulled = self._run([self._docker, "pull", self.image], capture_output=True, text=True, timeout=timeout)
        if pulled.returncode != 0:
            raise IsolationUnavailable(f"could not pull {self.image}: {pulled.stderr.strip()[-200:]}")

    # -- command construction -------------------------------------------------------------------

    def build_command(self, workspace: Path, profile: str, name: str) -> List[str]:
        argv = self._profiles[profile]  # KeyError for anything not in trusted configuration
        ws = str(Path(workspace).resolve())
        if "," in ws or '"' in ws or "\n" in ws:
            # --mount options are comma separated; refuse paths that could smuggle extra options.
            raise ValueError(f"workspace path not allowed for container mount: {ws!r}")
        cmd = [
            self._docker, "run", "--rm", "--init",
            "--name", name,
            "--label", "triad-verify=1",
            "--pull", "never",
            "--network", "none",
            "--ipc", "none",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--user", "65534:65534",
            "--read-only",
            "--tmpfs", f"/tmp:rw,nosuid,size={self.tmpfs_size}",
            "--memory", self.memory, "--memory-swap", self.memory,
            "--cpus", self.cpus,
            "--pids-limit", str(self.pids_limit),
            "--ulimit", "nofile=1024:1024",
            "--ulimit", "core=0",
            "--mount", f"type=bind,src={ws},dst=/work",
            "--workdir", "/work",
        ]
        for key, value in _SAFE_ENV.items():
            cmd += ["-e", f"{key}={value}"]
        return cmd + [self.image] + argv

    # -- execution ------------------------------------------------------------------------------

    def _cap(self, text: str) -> str:
        data = text or ""
        if len(data.encode("utf-8", "replace")) <= self.max_output_bytes:
            return data
        return data.encode("utf-8", "replace")[: self.max_output_bytes].decode("utf-8", "replace") + "\n[output truncated]"

    def _cleanup(self, name: str) -> None:
        try:
            self._run([self._docker, "rm", "-f", name], capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            pass

    def run(self, *, workspace: Path, profile: str, timeout: int) -> "subprocess.CompletedProcess[str]":
        ok, reason = self.available()
        if not ok:
            raise IsolationUnavailable(f"container runtime unavailable: {reason}")
        name = f"triad-verify-{uuid.uuid4().hex[:12]}"
        cmd = self.build_command(workspace, profile, name)
        try:
            res = self._run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            # Killing the docker CLI does not stop the container: kill it and every descendant.
            self._cleanup(name)
            raise
        finally:
            self._cleanup(name)
        return subprocess.CompletedProcess(res.args, res.returncode, self._cap(res.stdout), self._cap(res.stderr))
