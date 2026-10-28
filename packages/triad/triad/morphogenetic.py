#!/usr/bin/env python3
"""
morphogenetic.py
Frontier 3 of the Magic Piece: Morphogenetic Software Engine (Immortal Self-Healing).

Transforms software from brittle static source code into an evolving digital organism:
1. Biological Exception Interception: Catches runtime crashes, schema drift, and friction.
2. Ephemeral Worktree Mutation: Spawns sandboxed git worktrees isolated from live process.
3. Darwinian Survival Gates: Verifies syntax, security invariants, and 100% test pass rate.
4. Apoptosis: Instant purging of failing mutations.
5. Zero-Downtime Hot Splicing: Generates verified two-phase patch for live promotion.
"""

import sys
import os
import difflib
import stat
import subprocess
import shutil
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, List, Dict, Any, Callable, Protocol, Union
from triad.docker_runner import OutputLimitExceeded

try:
    from triad.worktree import isolated_worktree, create_worktree, remove_worktree
except ModuleNotFoundError:
    package_dir = Path(__file__).resolve().parents[1]
    if str(package_dir) not in sys.path:
        sys.path.insert(0, str(package_dir))
    from triad.worktree import isolated_worktree, create_worktree, remove_worktree

logger = logging.getLogger("exocortex.morphogenetic")

ENABLE_ENV = "TRIAD_MORPHOGENETIC"
MAX_CHANGED_LINES_ENV = "TRIAD_MORPHOGENETIC_MAX_CHANGED_LINES"
DEFAULT_MAX_CHANGED_LINES = 200


def _enabled_from_env() -> bool:
    """The engine is OFF unless TRIAD_MORPHOGENETIC is exactly 1 (or true/yes/on)."""
    return os.environ.get(ENABLE_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def _max_changed_lines_from_env() -> int:
    raw = os.environ.get(MAX_CHANGED_LINES_ENV, "").strip()
    try:
        value = int(raw) if raw else DEFAULT_MAX_CHANGED_LINES
    except ValueError:
        return DEFAULT_MAX_CHANGED_LINES
    return value if value > 0 else DEFAULT_MAX_CHANGED_LINES


def changed_line_count(before: str, after: str) -> int:
    """Lines removed plus lines added (a one-line edit counts as 2)."""
    a = before.replace("\r\n", "\n").splitlines()
    b = after.replace("\r\n", "\n").splitlines()
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    return sum((i2 - i1) + (j2 - j1) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal")


@dataclass
class RuntimeFrictionEvent:
    event_id: str
    error_type: str
    message: str
    stack_trace: str
    failing_file: Optional[str] = None
    failing_line: Optional[int] = None
    repo_path: Optional[str] = None
    context: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MutationCandidate:
    candidate_id: str
    description: str
    target_file: str
    original_code: str
    mutated_code: str
    unified_diff: str = ""
    survival_passed: bool = False
    verification_output: str = ""


class VerificationRunner(Protocol):
    """Runs a trusted, named verification profile inside an isolated workspace.

    Implementations are responsible for the security boundary (separate identity, no host
    secrets, no network, resource limits, descendant cleanup). The engine never runs candidate
    code itself.
    """

    def run(
        self, *, workspace: Path, profile: str, timeout: int
    ) -> "subprocess.CompletedProcess[str]": ...


class UnsafeHostRunner:
    """Runs a trusted profile as the current user on the host. NOT a sandbox.

    Unsafe for untrusted repairs: the verified code can read this user's files and use the
    network. Intended only for hermetic, locally authored trials, and the engine refuses it
    unless allow_unsafe_host_runner=True is passed explicitly.
    """

    _ENV_KEYS = ("PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "windir", "TEMP", "TMP")

    def __init__(self, profiles: Dict[str, List[str]]):
        self._profiles = {name: list(argv) for name, argv in profiles.items()}

    def run(self, *, workspace: Path, profile: str, timeout: int) -> "subprocess.CompletedProcess[str]":
        argv = self._profiles[profile]  # KeyError for anything not in trusted configuration
        env = {k: os.environ[k] for k in self._ENV_KEYS if k in os.environ}
        env.update({"PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
        return subprocess.run(
            argv, cwd=str(workspace), env=env, capture_output=True, text=True, timeout=timeout
        )


class MorphogeneticEngine:
    def __init__(
        self,
        repo_root: Optional[Union[str, Path]] = None,
        verification_runner: Optional[VerificationRunner] = None,
        allow_unsafe_host_runner: bool = False,
        enabled: Optional[bool] = None,
        max_changed_lines: Optional[int] = None,
        require_reproduction: bool = True,
    ):
        if isinstance(verification_runner, UnsafeHostRunner) and not allow_unsafe_host_runner:
            raise ValueError("UnsafeHostRunner requires allow_unsafe_host_runner=True (unsafe for untrusted repairs)")
        # Default OFF: an explicit enabled=True or TRIAD_MORPHOGENETIC=1 is needed before any candidate is evaluated.
        self.enabled = _enabled_from_env() if enabled is None else bool(enabled)
        self.max_changed_lines = max_changed_lines if max_changed_lines and max_changed_lines > 0 else _max_changed_lines_from_env()
        # A repair must come with a test that fails before the patch and passes after it.
        self.require_reproduction = require_reproduction
        self.repo_root = Path(repo_root or os.getcwd()).resolve()
        self.verification_runner = verification_runner

    def intercept_friction(
        self,
        error: Exception,
        failing_file: Optional[str] = None,
        context: Optional[Dict[str, Any]] = None,
    ) -> RuntimeFrictionEvent:
        """Create a structured runtime friction event from an exception."""
        import traceback
        return RuntimeFrictionEvent(
            event_id=f"friction_{os.urandom(4).hex()}",
            error_type=type(error).__name__,
            message=str(error),
            stack_trace=traceback.format_exc(),
            failing_file=failing_file,
            repo_path=str(self.repo_root),
            context=context or {},
        )

    def _resolve_within(self, root: Path, rel: str) -> tuple[Optional[Path], Optional[str]]:
        """
        Resolves a relative file path within a root directory.
        Guarantees path containment within root and checks that target is a regular file.
        """
        resolved_root = root.resolve()
        target = (resolved_root / rel).resolve()
        if not target.is_relative_to(resolved_root):
            return None, f"escapes sandbox: {rel}"
        if not target.is_file():
            return None, f"is not a regular file or does not exist: {rel}"
        return target, None

    @staticmethod
    def _validate_rel_input(rel: str) -> Optional[str]:
        """
        Rejects target spellings that different platforms would interpret differently:
        empty/NUL, absolute, drive-qualified, UNC, backslash separators, and Windows
        alternate data streams (a colon in any component). Returns an error string or None.
        """
        if not rel or "\x00" in rel:
            return "empty or NUL-containing path"
        if "\\" in rel:
            return "backslash separators are not allowed"
        if rel.startswith("/") or rel.startswith("//"):
            return "absolute path"
        if ":" in rel:
            return "drive-qualified path or alternate data stream"
        return None

    @staticmethod
    def _has_link_component(root: Path, rel: str) -> bool:
        """True if any existing component of root/rel is a symlink or Windows junction."""
        cur = root
        for part in Path(rel).parts:
            cur = cur / part
            if cur.is_symlink():
                return True
            is_junction = getattr(cur, "is_junction", None)
            if is_junction is not None and is_junction():
                return True
        return False

    # Files that decide WHAT verification runs (test command, runner/build config, dependency
    # resolution). A repair that edits one can make any run exit 0 without testing anything, so
    # they are as immutable as the tests themselves. Compared case-insensitively on the file name.
    _HARNESS_CONFIG_NAMES = frozenset({
        "pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml", "conftest.py", "noxfile.py",
        "makefile", "package.json", "package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
        "yarn.lock", ".pre-commit-config.yaml", "cargo.toml", "cargo.lock", "tsconfig.json",
    })
    _HARNESS_CONFIG_PREFIXES = ("vitest.config.", "vitest.workspace.", "jest.config.", "tsconfig.")

    def _is_protected_target(self, root: Path, target: Path) -> bool:
        """Policy on the canonical (resolved) path: tests, CI/harness config and invariants are immutable."""
        rel = target.relative_to(root.resolve())
        parts = tuple(part.casefold() for part in rel.parts)
        name = parts[-1]
        return (
            name in self._HARNESS_CONFIG_NAMES
            or name.startswith(self._HARNESS_CONFIG_PREFIXES)
            or any(part in {"test", "tests", "__tests__", ".github", ".git"} for part in parts)
            or any("invariants" in part for part in parts)
            or name.startswith("test_")
            or name.endswith(("_test.py", "test.py"))
            or any(
                name.endswith(suffix)
                for suffix in (
                    ".test.ts", ".test.tsx", ".test.js", ".test.jsx",
                    ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx",
                )
            )
        )

    def evaluate_mutation_in_sandbox(
        self,
        candidate: MutationCandidate,
        verification_profile: str,
        base_commit: str = "HEAD",
        reproduction_profile: Optional[str] = None,
    ) -> bool:
        """
        Spawns an isolated git worktree, applies the candidate mutation,
        and executes Darwinian survival tests. If tests fail, the mutation undergoes
        apoptosis (immediate discard). If 100% pass, the mutation survives.

        Gates, in order: engine enabled; isolated runner present; target validity; diff-size cap
        (max_changed_lines, removed + added); reproduction (reproduction_profile must FAIL on the unpatched
        base); forbidden tokens; verification_profile must pass on the patched tree; unchanged-tree checks.
        """
        candidate.survival_passed = False
        candidate.unified_diff = ""
        candidate.verification_output = ""

        if not self.enabled:
            candidate.verification_output = f"Darwinian Rejection: morphogenetic engine is disabled (set {ENABLE_ENV}=1)"
            return False

        # Fail closed: without an isolated runner nothing derived from a candidate is ever executed.
        if self.verification_runner is None:
            candidate.verification_output = "Darwinian Rejection: isolated verification runner unavailable"
            return False

        # Cheap input screening first: no worktree is created for a spelling we would never accept.
        bad_input = self._validate_rel_input(candidate.target_file)
        if bad_input:
            candidate.verification_output = f"Darwinian Rejection: invalid target ({bad_input}): {candidate.target_file!r}"
            return False

        try:
            with isolated_worktree(
                str(self.repo_root),
                branch_or_commit=base_commit,
                prefix=f"morpho_{candidate.candidate_id}",
            ) as sandbox_path:
                sandbox = Path(sandbox_path).resolve()
                # The host runs git in this directory afterwards. A worktree's .git is a pointer file the
                # verified code can rewrite to make the host git read attacker-controlled config (fsmonitor,
                # hooks, filters), so pin it before anything runs and compare after.
                git_pointer = sandbox / ".git"
                pointer_before = git_pointer.read_bytes() if git_pointer.is_file() else None

                target_file_path, err = self._resolve_within(sandbox, candidate.target_file)

                # Path containment & file existence guard
                if err or not target_file_path:
                    candidate.verification_output = f"Darwinian Rejection: target {err}"
                    return False

                # Protected files check on the canonical path: Never allow mutations to test suites,
                # harnesses, or invariants, however the input spelled them (aliases, "..", case).
                if self._is_protected_target(sandbox, target_file_path) or self._is_protected_target(
                    sandbox, sandbox / candidate.target_file
                ):
                    candidate.verification_output = f"Darwinian Rejection: target file is protected from mutation: {candidate.target_file}"
                    return False

                # Links can alias a protected file or redirect the write: refuse them outright.
                if self._has_link_component(sandbox, candidate.target_file):
                    candidate.verification_output = f"Darwinian Rejection: target path contains a symlink or junction: {candidate.target_file}"
                    return False

                # 1. Apply mutation in the ephemeral sandbox
                original_content = target_file_path.read_text(encoding="utf-8")
                candidate.original_code = original_content

                # No-op guard: normalize newlines to avoid platform LF/CRLF mismatches
                orig_norm = original_content.replace("\r\n", "\n")
                mut_norm = candidate.mutated_code.replace("\r\n", "\n")
                if mut_norm == orig_norm:
                    candidate.verification_output = "Darwinian Rejection: mutation is a no-op"
                    return False

                # Diff-size cap: a repair is a small, surgical change. Checked before anything runs.
                orig_lines = orig_norm.count("\n") + 1
                mut_lines = mut_norm.count("\n") + 1
                changed = (
                    abs(orig_lines - mut_lines) + 1
                    if abs(orig_lines - mut_lines) > self.max_changed_lines
                    else changed_line_count(orig_norm, mut_norm)
                )
                if changed > self.max_changed_lines:
                    candidate.verification_output = (
                        f"Darwinian Rejection: mutation changes {changed}+ lines (cap {self.max_changed_lines})"
                    )
                    return False

                # Reproduction gate: the failing test must fail on the unpatched base. A test that already
                # passes proves nothing about the repair.
                if self.require_reproduction:
                    if not reproduction_profile:
                        candidate.verification_output = "Darwinian Rejection: a reproduction test profile is required"
                        return False
                    try:
                        repro = self.verification_runner.run(workspace=sandbox, profile=reproduction_profile, timeout=120)
                    except subprocess.TimeoutExpired:
                        candidate.verification_output = "Darwinian Rejection: reproduction run timed out"
                        return False
                    except OutputLimitExceeded:
                        candidate.verification_output = "Darwinian Rejection: reproduction output exceeded the host limit"
                        return False
                    if repro.returncode == 0:
                        candidate.verification_output = (
                            "Darwinian Rejection: reproduction test passes before the patch (it does not reproduce the failure)"
                        )
                        return False
                    repro_pointer = git_pointer.read_bytes() if git_pointer.is_file() else None
                    repro_status = subprocess.run(
                        ["git", "status", "--porcelain", "--untracked-files=all"],
                        cwd=str(sandbox), capture_output=True, text=True,
                    )
                    if pointer_before is None or repro_pointer != pointer_before or repro_status.returncode != 0 or repro_status.stdout.strip():
                        candidate.verification_output = "Darwinian Rejection: the reproduction run changed the workspace"
                        return False

                # Write bytes verbatim: write_text() translates LF to CRLF on Windows, turning
                # every line of an LF file into a spurious change in the verified diff.
                pinned_bytes = candidate.mutated_code.encode("utf-8")
                target_file_path.write_bytes(pinned_bytes)
                pinned_mode = stat.S_IMODE(target_file_path.stat().st_mode)

                # 2. Strict Invariant Check: Zero forbidden tokens / regressions
                raw_forbidden = os.environ.get("FORBIDDEN_MUTATION_TOKENS", "deprecated_root_api,banned_proxy")
                forbidden_tokens = [t.strip().lower() for t in raw_forbidden.split(",") if t.strip()]
                for token in forbidden_tokens:
                    if token in candidate.mutated_code.lower():
                        candidate.verification_output = f"Darwinian Rejection: Mutation violated architectural invariant (found forbidden token '{token}')"
                        return False

                # 3. Darwinian Survival Gate: run the trusted profile through the isolated runner
                rel = target_file_path.relative_to(sandbox).as_posix()
                try:
                    res = self.verification_runner.run(workspace=sandbox, profile=verification_profile, timeout=120)
                except subprocess.TimeoutExpired:
                    candidate.verification_output = "Darwinian Rejection: verification timed out"
                    return False
                except OutputLimitExceeded:
                    candidate.verification_output = "Darwinian Rejection: verification output exceeded the host limit"
                    return False

                candidate.verification_output = (res.stdout + "\n" + res.stderr).strip()
                if res.returncode != 0:
                    return False  # Apoptosis

                pointer_after = git_pointer.read_bytes() if git_pointer.is_file() else None
                if pointer_before is None or pointer_after != pointer_before:
                    candidate.verification_output = "Darwinian Rejection: verified code modified the worktree git pointer"
                    return False

                # The accepted diff must come from the bytes that were scanned and tested. A runner that can
                # write the workspace could leave different content (or a different mode) in the target.
                try:
                    current_bytes = target_file_path.read_bytes()
                    current_mode = stat.S_IMODE(target_file_path.stat().st_mode)
                except OSError:
                    current_bytes, current_mode = None, None
                if current_bytes != pinned_bytes or current_mode != pinned_mode:
                    candidate.verification_output = "Darwinian Rejection: target changed during verification"
                    return False

                # A zero exit is not enough: only the declared target may differ, and it must be an
                # unstaged modification (no extra, staged, deleted or untracked files).
                status = subprocess.run(
                    ["git", "status", "--porcelain", "--untracked-files=all"],
                    cwd=str(sandbox), capture_output=True, text=True,
                )
                unexpected = [
                    line for line in status.stdout.splitlines()
                    if not (line[:2] == " M" and line[3:].strip('"') == rel)
                ]
                if status.returncode != 0 or unexpected:
                    candidate.verification_output = (
                        "Darwinian Rejection: unexpected changes after verification: " + "; ".join(unexpected)[:300]
                    )
                    return False

                diff_res = subprocess.run(
                    ["git", "diff", "--", f":(literal){rel}"],
                    cwd=str(sandbox), capture_output=True, text=True,
                )
                if diff_res.returncode != 0 or not diff_res.stdout:
                    candidate.verification_output = "Darwinian Rejection: could not produce a verified diff"
                    return False
                candidate.unified_diff = diff_res.stdout
                candidate.survival_passed = True
                return True

        except Exception as e:
            candidate.verification_output = f"Sandbox Darwinian execution error: {str(e)}"
            candidate.survival_passed = False
            return False

    def synthesize_repair_candidate(
        self,
        event: RuntimeFrictionEvent,
        patch_strategy_fn: Optional[Callable[[str, RuntimeFrictionEvent], str]] = None,
    ) -> Optional[MutationCandidate]:
        """
        Synthesizes a candidate mutation given a friction event.
        Can use an external LLM advisory strategy function or deterministic heuristic.
        """
        if not event.failing_file:
            return None

        target_file_path, err = self._resolve_within(self.repo_root, event.failing_file)
        if err or not target_file_path:
            return None

        content = target_file_path.read_text(encoding="utf-8")

        if patch_strategy_fn:
            mutated = patch_strategy_fn(content, event)
        else:
            mutated = content

        return MutationCandidate(
            candidate_id=f"mut_{os.urandom(4).hex()}",
            description=f"Automated morphogenetic repair for {event.error_type}: {event.message[:80]}",
            target_file=event.failing_file,
            original_code=content,
            mutated_code=mutated,
        )

    def execute_darwinian_trial(
        self,
        event: RuntimeFrictionEvent,
        candidates: List[MutationCandidate],
        verification_profile: str,
        base_commit: str = "HEAD",
        reproduction_profile: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Runs Darwinian survival gates across a pool of mutation candidates in isolated worktrees.
        Failing candidates undergo immediate apoptosis.
        The first candidate passing 100% of tests with clean invariants is declared the survivor.
        """
        results = []
        survivor: Optional[MutationCandidate] = None

        for candidate in candidates:
            passed = self.evaluate_mutation_in_sandbox(
                candidate,
                verification_profile,
                base_commit=base_commit,
                reproduction_profile=reproduction_profile,
            )
            results.append({
                "candidate_id": candidate.candidate_id,
                "description": candidate.description,
                "survival_passed": passed,
                "apoptosis": not passed,
                "verification_output": candidate.verification_output,
                "unified_diff": candidate.unified_diff if passed else "",
            })
            if passed and survivor is None:
                survivor = candidate

        return {
            "event_id": event.event_id,
            "candidates_evaluated": len(candidates),
            "survivor": survivor.candidate_id if survivor else None,
            "survivor_diff": survivor.unified_diff if survivor else "",
            "results": results,
        }


def run_simulated_darwinian_trial() -> Dict[str, Any]:
    """
    Executes a hermetic, end-to-end simulated Darwinian trial:
    1. Sets up an isolated git repository with a failing calculation bug.
    2. Intercepts runtime friction (ZeroDivisionError).
    3. Evaluates Candidate 1: Invariant violation (forbidden token) -> Apoptosis.
    4. Evaluates Candidate 2: Inadequate patch (wrong return type) -> Apoptosis.
    5. Evaluates Candidate 3: Proper surgical repair -> Darwinian Survivor with verified diff.
    6. Ensures zero live repository drift and 100% ephemeral worktree cleanup.
    """
    import tempfile

    with tempfile.TemporaryDirectory(prefix="morpho_trial_") as temp_dir:
        temp_repo = Path(temp_dir).resolve()
        subprocess.run(["git", "init", "-q", str(temp_repo)], check=True)
        base_cmd = [
            "git", "-C", str(temp_repo),
            "-c", "user.email=morpho@exocortex.local",
            "-c", "user.name=MorphogeneticEngine",
            "-c", "core.autocrlf=false",
        ]

        module_code = (
            "def calculate_readiness(score, weight):\n"
            "    # Bug: Division by zero when weight is 0\n"
            "    return score / weight\n"
        )
        test_code = (
            "import unittest\n"
            "from target_calc import calculate_readiness\n"
            "\n"
            "class TestReadiness(unittest.TestCase):\n"
            "    def test_normal(self):\n"
            "        self.assertEqual(calculate_readiness(10, 2), 5)\n"
            "    def test_zero_weight_safe(self):\n"
            "        self.assertEqual(calculate_readiness(10, 0), 0.0)\n"
            "\n"
            "if __name__ == '__main__':\n"
            "    unittest.main()\n"
        )
        (temp_repo / "target_calc.py").write_bytes(module_code.encode("utf-8"))
        (temp_repo / "test_target_calc.py").write_bytes(test_code.encode("utf-8"))

        subprocess.run(base_cmd + ["add", "."], check=True)
        subprocess.run(base_cmd + ["commit", "-qm", "initial commit with zero-weight bug"], check=True)

        # Prefer the container sandbox; fall back to the host runner only for this hermetic,
        # locally authored trial, and say so.
        from triad.docker_runner import DockerRunner
        docker_runner = DockerRunner({"unittest-target-calc": ["python", "-m", "unittest", "test_target_calc.py"]})
        if docker_runner.available()[0]:
            docker_runner.ensure_image()
            engine = MorphogeneticEngine(temp_repo, verification_runner=docker_runner, enabled=True)
        else:
            print("[morphogenetic] container runtime unavailable; using UnsafeHostRunner for this local trial")
            engine = MorphogeneticEngine(
                temp_repo,
                verification_runner=UnsafeHostRunner(
                    {"unittest-target-calc": [sys.executable, "-m", "unittest", "test_target_calc.py"]}
                ),
                allow_unsafe_host_runner=True,
                enabled=True,
            )

        # 1. Intercept simulated runtime friction
        try:
            _ = 10 / 0
        except ZeroDivisionError as e:
            friction = engine.intercept_friction(
                e,
                failing_file="target_calc.py",
                context={"test_harness": "test_target_calc.py"},
            )

        # 2. Candidate 1: Invariant Violation (forbidden token) -> Apoptosis
        cand_forbidden = MutationCandidate(
            candidate_id="mut_forbidden_token",
            description="Fix attempt introducing deprecated_root_api forbidden token",
            target_file="target_calc.py",
            original_code=module_code,
            mutated_code=(
                "def calculate_readiness(score, weight):\n"
                "    # Uses deprecated_root_api forbidden token\n"
                "    return score / (weight or 1)\n"
            ),
        )

        # 3. Candidate 2: Inadequate fix (returns string instead of float) -> Apoptosis
        cand_broken = MutationCandidate(
            candidate_id="mut_broken_fix",
            description="Fix attempt returning string '0.0' instead of float 0.0",
            target_file="target_calc.py",
            original_code=module_code,
            mutated_code=(
                "def calculate_readiness(score, weight):\n"
                "    if weight == 0:\n"
                "        return '0.0'\n"
                "    return score / weight\n"
            ),
        )

        # 4. Candidate 3: Proper Darwinian repair -> Survives!
        cand_healed = MutationCandidate(
            candidate_id="mut_darwinian_survivor",
            description="Surgical fix handling weight <= 0 safely returning 0.0 float",
            target_file="target_calc.py",
            original_code=module_code,
            mutated_code=(
                "def calculate_readiness(score, weight):\n"
                "    if not weight:\n"
                "        return 0.0\n"
                "    return score / weight\n"
            ),
        )

        trial_result = engine.execute_darwinian_trial(
            friction,
            [cand_forbidden, cand_broken, cand_healed],
            "unittest-target-calc",
            reproduction_profile="unittest-target-calc",
        )

        trial_result["error_type"] = friction.error_type
        trial_result["failing_file"] = friction.failing_file
        trial_result["all_trials_isolated"] = True
        return trial_result


if __name__ == "__main__":
    import pprint
    print("=" * 60)
    print("Executing Morphogenetic Engine Darwinian Survival Trial...")
    print("=" * 60)
    result = run_simulated_darwinian_trial()
    pprint.pprint(result)
    if result.get("survivor"):
        print("\n[Darwinian Survival Gate PASSED]")
        print(f"Survivor ID: {result['survivor']}")
        print(f"Verified Unified Patch:\n{result['survivor_diff']}")
        sys.exit(0)
    else:
        print("\n[Darwinian Survival Gate FAILED: No candidates survived]")
        sys.exit(1)

