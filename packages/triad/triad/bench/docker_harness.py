#!/usr/bin/env python3
"""Repo-native SWE-bench tests in Docker, using the local bare clone.

Django runs ``tests/runtests.py``. Astropy is a C-extension package, so it
runs only when ``TRIAD_ASTROPY_IMAGE`` names a prebuilt image. If Docker or
the clone is missing, callers keep the existing judge path.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Dict, List, Optional


def bare_repo_dirname(repo: str) -> str:
    """Cache key includes the owner so two ``django`` repos cannot collide."""
    safe = repo.replace("\\", "/").strip().strip("/")
    return safe.replace("/", "__") + ".git"


def resolve_bare_repo(repos_dir: Path, repo: str) -> Optional[Path]:
    """Prefer ``owner__repo.git``. Fall back to an older ``repo.git`` clone."""
    primary = repos_dir / bare_repo_dirname(repo)
    if (primary / "HEAD").exists():
        return primary
    legacy_name = repo.replace("\\", "/").rstrip("/").split("/")[-1] + ".git"
    legacy = repos_dir / legacy_name
    if legacy != primary and (legacy / "HEAD").exists():
        return legacy
    return None


def destination_bare_repo(repos_dir: Path, repo: str) -> Path:
    """Where a new clone should be written. Keeps an existing legacy clone."""
    existing = resolve_bare_repo(repos_dir, repo)
    if existing is not None:
        return existing
    return repos_dir / bare_repo_dirname(repo)


def django_test_labels(tests: List[str]) -> List[str]:
    """Turn SWE-bench ids into Django ``runtests.py`` labels.

    Prose that is not a test id is omitted. ``runtests.py`` would treat it as
    a missing module and the caller would score that as a patch failure.
    """
    labels = []
    unittest_id = re.compile(r"^(\w+)\s+\(([\w.]+)\)$")
    for raw in tests:
        text = (raw or "").strip()
        if not text:
            continue
        matched = unittest_id.match(text)
        if matched:
            labels.append(f"{matched.group(2)}.{matched.group(1)}")
            continue
        path, _, rest = text.partition("::")
        if not path.endswith(".py"):
            continue
        module = path[:-3].replace("\\", "/").replace("/", ".")
        if module.startswith("tests."):
            module = module[len("tests."):]
        if rest:
            module = module + "." + rest.replace("::", ".")
        labels.append(module)
    return labels


def native_test_argv(repo: str, tests: List[str]) -> Optional[List[str]]:
    """Repo-native command, or None when this repo has no harness here."""
    if repo == "django/django":
        usable = [text.strip() for text in tests if (text or "").strip()]
        labels = django_test_labels(usable)
        # A partial label list would score a pass on the tests we could name.
        if not usable or len(labels) != len(usable):
            return None
        return ["python", "tests/runtests.py", "--verbosity", "1", *labels]
    if repo == "astropy/astropy":
        image = os.environ.get("TRIAD_ASTROPY_IMAGE", "").strip()
        if not image:
            return None
        return ["python", "-m", "pytest", "-q", "--tb=line", *tests]
    return None


def _docker_bind(path: Path) -> str:
    """Host path Docker can mount. Windows drive letters become ``/c/...``."""
    resolved = str(path.resolve())
    if os.name == "nt":
        drive, rest = os.path.splitdrive(resolved)
        letter = drive[0].lower() if drive else ""
        resolved = f"/{letter}{rest.replace(chr(92), '/')}" if letter else rest.replace(chr(92), "/")
    return f"{resolved}:/src"


def runner_executed(returncode: int, output: str) -> bool:
    """True only when the test runner itself ran.

    Install failures, import errors, usage errors, and collection errors stay
    false so the caller can keep the host pytest and judge path.
    """
    text = output or ""
    lower = text.lower()
    if returncode == 2:
        return False
    if returncode == 0:
        return True
    # unittest reports a missing module as one ``_FailedTest`` plus "Ran 1 test".
    if "_failedtest" in lower or "failed to import test module" in lower:
        return False
    if re.search(r"\bran \d+ tests?\b", lower):
        return True
    harness = any(
        mark in lower
        for mark in (
            "importerror",
            "modulenotfounderror",
            "no module named",
            "usage:",
            "unrecognized arguments",
            "error: file or directory not found",
            "errors during collection",
            "interrupted",
        )
    )
    if harness:
        return False
    return "short test summary" in lower or bool(re.search(r"\b\d+ failed\b", lower))


def docker_outcome(returncode: int, output: str) -> str:
    """``pass`` only for a clean run. Skips and failures stay on the host path.

    A bare ``python:3.11`` image can print ``OK (skipped=1)`` when a Django
    dependency is missing, and an old Django tree can fail on 3.11 for reasons
    that are not the patch. Neither one is a score.
    """
    if returncode != 0 or not runner_executed(returncode, output or ""):
        return "fallback"
    if re.search(r"skipped=\d+", output or "", re.IGNORECASE):
        return "fallback"
    return "pass"


def docker_is_running() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        probe = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return probe.returncode == 0


def checkout_argv(checkout: Path, base_commit: str) -> List[str]:
    """Detach at a commit. ``--detach`` stays an option; the commit is not one."""
    return [
        "git", "-C", str(checkout), "checkout",
        "--detach", "--end-of-options", base_commit, "--",
    ]


def _apply_patch(checkout: Path, patch_text: str) -> bool:
    if not patch_text or not patch_text.strip():
        return True
    patch_file = checkout / ".triad_eval.patch"
    patch_file.write_text(patch_text if patch_text.endswith("\n") else patch_text + "\n", encoding="utf-8")
    try:
        result = subprocess.run(
            ["git", "-C", str(checkout), "apply", "--recount", str(patch_file)],
            capture_output=True,
            timeout=60,
        )
        return result.returncode == 0
    finally:
        try:
            patch_file.unlink()
        except OSError:
            pass


def try_native_docker_tests(
    repo: str,
    base_commit: str,
    candidate_patch: str,
    test_patch: str,
    tests: List[str],
    *,
    repos_dir: Path,
    timeout: int = 900,
) -> Dict[str, object]:
    """Run the repo's own tests in Docker. ``executed`` is false when we did not start them."""
    skipped = {"executed": False, "passed": False, "method": "DOCKER_SKIPPED", "message": ""}
    if not docker_is_running():
        skipped["message"] = "Docker is not running"
        return skipped
    argv = native_test_argv(repo, tests)
    if argv is None:
        if repo == "astropy/astropy":
            skipped["message"] = "Astropy needs a prebuilt image in TRIAD_ASTROPY_IMAGE"
        else:
            skipped["message"] = f"No repo-native Docker harness for {repo}"
        return skipped
    bare = resolve_bare_repo(repos_dir, repo)
    if bare is None:
        skipped["message"] = f"No local bare clone for {repo}"
        return skipped

    image = os.environ.get("TRIAD_ASTROPY_IMAGE", "").strip() if repo == "astropy/astropy" else "python:3.11"
    checkout_parent = Path(tempfile.mkdtemp(prefix="triad-docker-eval-"))
    checkout = checkout_parent / "src"
    try:
        cloned = subprocess.run(
            ["git", "clone", "--shared", "--no-checkout", str(bare), str(checkout)],
            capture_output=True,
            timeout=180,
        )
        if cloned.returncode != 0:
            skipped["message"] = "Could not clone the local bare repo"
            return skipped
        checked = subprocess.run(
            checkout_argv(checkout, base_commit),
            capture_output=True,
            timeout=180,
        )
        if checked.returncode != 0:
            skipped["message"] = f"Commit {base_commit[:12]} is not in the local clone"
            return skipped
        if not _apply_patch(checkout, test_patch) or not _apply_patch(checkout, candidate_patch):
            skipped["message"] = "Patch did not apply in the target checkout"
            return skipped

        container = f"triad-eval-{uuid.uuid4().hex[:12]}"
        if repo == "django/django":
            labels = django_test_labels(tests)
            inner = (
                "import subprocess,sys; "
                "setup=subprocess.call([sys.executable,'-m','pip','install','-q','-e','.']); "
                "sys.exit(2 if setup else subprocess.call([sys.executable,'tests/runtests.py','--verbosity','1',*sys.argv[1:]]))"
            )
            cmd = [
                "docker", "run", "--rm", "--name", container,
                "--memory", "4g", "--pids-limit", "512",
                "-v", _docker_bind(checkout),
                "-w", "/src",
                image,
                "python", "-c", inner, *labels,
            ]
        else:
            cmd = [
                "docker", "run", "--rm", "--name", container,
                "--memory", "4g", "--pids-limit", "512",
                "-v", _docker_bind(checkout),
                "-w", "/src",
                image,
                *argv,
            ]
        try:
            ran = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                subprocess.run(["docker", "kill", container], capture_output=True, timeout=30)
            except (OSError, subprocess.TimeoutExpired):
                pass
            skipped["message"] = f"Docker test run timed out after {timeout}s; keeping the host path"
            return skipped
        except OSError as exc:
            skipped["message"] = f"Docker could not start: {exc}"
            return skipped
        output = f"{ran.stdout or ''}\n{ran.stderr or ''}"
        if docker_outcome(ran.returncode, output) != "pass":
            skipped["message"] = "Docker did not produce a clean pass; keeping the host path"
            return skipped
        return {
            "executed": True,
            "passed": True,
            "method": "DOCKER_NATIVE",
            "message": f"Repo-native tests passed in {image}",
        }
    finally:
        shutil.rmtree(checkout_parent, ignore_errors=True)
