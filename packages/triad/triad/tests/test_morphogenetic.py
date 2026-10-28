#!/usr/bin/env python3
"""
Unit tests for Frontier 3 Morphogenetic Software Engine (test_morphogenetic.py).
"""

import sys
import unittest
import os
import subprocess
from pathlib import Path
from triad.morphogenetic import MorphogeneticEngine, RuntimeFrictionEvent, MutationCandidate


def _Engine(*args, **kwargs):
    """Engine for tests of the other gates: enabled, and without the reproduction requirement (tested separately)."""
    kwargs.setdefault("enabled", True)
    kwargs.setdefault("require_reproduction", False)
    return MorphogeneticEngine(*args, **kwargs)



class TestMorphogeneticEngine(unittest.TestCase):
    def setUp(self):
        self.repo_root = Path(__file__).resolve().parents[4]
        self.engine = _Engine(self.repo_root, verification_runner=FakeRunner())

    def test_intercept_friction(self):
        try:
            raise ValueError("Simulated runtime schema regression")
        except Exception as e:
            event = self.engine.intercept_friction(e, failing_file="packages/core/src/types.ts")

        self.assertEqual(event.error_type, "ValueError")
        self.assertIn("Simulated runtime schema regression", event.message)
        self.assertEqual(event.failing_file, "packages/core/src/types.ts")
        self.assertTrue(event.event_id.startswith("friction_"))

    def test_forbidden_token_apoptosis(self):
        # A candidate mutation containing forbidden architectural tokens MUST be rejected immediately
        candidate = MutationCandidate(
            candidate_id="bad_mut",
            description="Attempt to reintroduce banned dependency",
            target_file="README.md",
            original_code="{}",
            mutated_code='{"dependency": "deprecated_root_api"}',
        )

        survived = self.engine.evaluate_mutation_in_sandbox(
            candidate,
            verification_profile="unit",
        )

        self.assertFalse(survived)
        self.assertFalse(candidate.survival_passed)
        self.assertIn("violated architectural invariant", candidate.verification_output)

    def test_synthesize_repair_candidate(self):
        event = RuntimeFrictionEvent(
            event_id="f1",
            error_type="SyntaxError",
            message="unexpected token",
            stack_trace="",
            failing_file="package.json",
        )

        candidate = self.engine.synthesize_repair_candidate(
            event,
            patch_strategy_fn=lambda content, ev: content + "\n<!-- healed -->\n",
        )

        self.assertIsNotNone(candidate)
        self.assertTrue(candidate.candidate_id.startswith("mut_"))
        self.assertIn("<!-- healed -->", candidate.mutated_code)

    def test_path_jail_traversal_rejection(self):
        outside_path = self.repo_root.parent / "outside_escape_test.txt"
        if outside_path.exists():
            outside_path.unlink()

        candidate = MutationCandidate(
            candidate_id="jailbreak_mut",
            description="Attempt to mutate outside sandbox",
            target_file="../../outside_escape_test.txt",
            original_code="safe",
            mutated_code="pwned",
        )
        survived = self.engine.evaluate_mutation_in_sandbox(
            candidate,
            verification_profile="unit",
        )
        self.assertFalse(survived)
        self.assertIn("escapes sandbox", candidate.verification_output)
        self.assertFalse(outside_path.exists(), "Target file must not be created outside sandbox")

    def test_noop_mutation_rejection(self):
        # Read hermetically from git HEAD to avoid uncommitted working tree differences
        res = subprocess.run(
            ["git", "show", "HEAD:README.md"],
            cwd=str(self.repo_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        head_pkg_content = res.stdout

        candidate = MutationCandidate(
            candidate_id="noop_mut",
            description="No-op mutation with different newline endings",
            target_file="README.md",
            original_code="",
            # Test that newline normalization (CRLF vs LF) correctly detects no-op
            mutated_code=head_pkg_content.replace("\n", "\r\n"),
        )
        survived = self.engine.evaluate_mutation_in_sandbox(
            candidate,
            verification_profile="unit",
        )
        self.assertFalse(survived)
        self.assertIn("mutation is a no-op", candidate.verification_output)




    def test_mutation_preserves_lf_line_endings_in_verified_diff(self):
        """Writing the mutation must not rewrite every line of an LF file as CRLF (Windows write_text)."""
        import tempfile
        NL = chr(10)
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            base = ["git", "-C", str(repo), "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.autocrlf=false"]
            subprocess.run(base + ["config", "core.autocrlf", "false"], check=True)
            (repo / "f.py").write_bytes(("a = 1" + NL + "b = 2" + NL + "c = 3" + NL).encode("utf-8"))
            subprocess.run(base + ["add", "."], check=True)
            subprocess.run(base + ["commit", "-qm", "init"], check=True)

            engine = _Engine(repo, verification_runner=FakeRunner())
            candidate = MutationCandidate(
                candidate_id="eol",
                description="single line change",
                target_file="f.py",
                original_code="",
                mutated_code="a = 1" + NL + "b = 99" + NL + "c = 3" + NL,
            )
            self.assertTrue(engine.evaluate_mutation_in_sandbox(candidate, "unit"))
            changed = [l for l in candidate.unified_diff.splitlines() if l[:1] in "+-" and l[:3] not in ("+++", "---")]
            self.assertEqual(changed, ["-b = 2", "+b = 99"])

    def test_simulated_darwinian_survival_trial(self):
        """End-to-end trial: validates apoptosis of broken/forbidden candidates and survival of valid patch."""
        from triad.morphogenetic import run_simulated_darwinian_trial
        result = run_simulated_darwinian_trial()
        self.assertTrue(result["all_trials_isolated"])
        self.assertEqual(result["candidates_evaluated"], 3)
        self.assertEqual(result["survivor"], "mut_darwinian_survivor")
        self.assertIn("+        return 0.0", result["survivor_diff"])

        results_by_id = {r["candidate_id"]: r for r in result["results"]}
        self.assertTrue(results_by_id["mut_forbidden_token"]["apoptosis"])
        self.assertTrue(results_by_id["mut_broken_fix"]["apoptosis"])
        self.assertFalse(results_by_id["mut_darwinian_survivor"]["apoptosis"])
        self.assertTrue(results_by_id["mut_darwinian_survivor"]["survival_passed"])


class TestProtectedTargetPolicy(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.root = Path(self._td.name).resolve()
        self.engine = _Engine(self.root, verification_runner=FakeRunner())

    def _protected(self, rel):
        return self.engine._is_protected_target(self.root, (self.root / rel).resolve())

    def test_protected_paths(self):
        for rel in [
            "tests/helper.py", "pkg/tests/x.py", "pkg/test/x.py", "__tests__/a.ts",
            "test_example.py", "src/test_example.py", "src/foo_test.py", "src/footest.py",
            "a.spec.ts", "a.test.tsx", "src/b.spec.jsx", ".github/wf.yml", "invariants/x.py",
            "src/invariants_check.py", "TESTS/x.py", "Tests/Helper.PY",
        ]:
            with self.subTest(rel=rel):
                self.assertTrue(self._protected(rel), rel)

    def test_harness_and_build_config_decide_what_verification_runs_so_they_are_protected(self):
        for rel in [
            "pytest.ini", "tox.ini", "setup.cfg", "pyproject.toml", "conftest.py", "pkg/conftest.py",
            "Makefile", "package.json", "packages/core/package.json", "package-lock.json",
            "pnpm-lock.yaml", "yarn.lock", "vitest.config.ts", "apps/mobile/vitest.config.mts",
            "jest.config.js", "vitest.workspace.ts", "noxfile.py", ".pre-commit-config.yaml",
            "Cargo.toml", "tsconfig.json", "PYTEST.INI",
        ]:
            with self.subTest(rel=rel):
                self.assertTrue(self._protected(rel), rel)

    def test_ordinary_source_is_not_protected(self):
        for rel in ["src/app.py", "packages/core/index.ts", "latest/notes.py", "contest.md"]:
            with self.subTest(rel=rel):
                self.assertFalse(self._protected(rel), rel)

    def test_dotdot_normalisation_cannot_hide_a_protected_target(self):
        self.assertTrue(self._protected("src/../tests/helper.py"))

    def test_input_validation_rejects_ambiguous_paths(self):
        v = MorphogeneticEngine._validate_rel_input
        bad_inputs = ["/etc/x", "C:\\x", "C:x", "\\\\srv\\s\\x", "a.py:stream", "src\\app.py", "", "a\x00b"]
        for bad in bad_inputs:
            with self.subTest(bad=bad):
                self.assertIsNotNone(v(bad), repr(bad))
        for good in ["src/app.py", "package.json", "packages/core/index.ts"]:
            with self.subTest(good=good):
                self.assertIsNone(v(good), good)

    def _repo_with_alias(self, link_rel, target_rel):
        repo = self.root
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        base = ["git", "-C", str(repo), "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.autocrlf=false"]
        (repo / "tests").mkdir()
        (repo / "tests" / "helper.py").write_text("x = 1\n", encoding="utf-8")
        (repo / "src").mkdir()
        (repo / "src" / "app.py").write_text("y = 1\n", encoding="utf-8")
        try:
            os.symlink(os.path.relpath(repo / target_rel, (repo / link_rel).parent), repo / link_rel)
        except (OSError, NotImplementedError) as e:
            self.skipTest(f"cannot create symlinks on this platform: {e}")
        subprocess.run(base + ["config", "core.symlinks", "true"], check=True)
        subprocess.run(base + ["add", "-A"], check=True)
        subprocess.run(base + ["commit", "-qm", "init"], check=True)
        return _Engine(repo, verification_runner=FakeRunner())

    def test_in_root_alias_to_a_protected_file_is_rejected(self):
        engine = self._repo_with_alias("src/alias.py", "tests/helper.py")
        cand = MutationCandidate("alias", "d", "src/alias.py", "", "x = 2\n")
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertRegex(cand.verification_output, r"protected|link")

    def test_in_root_alias_to_an_ordinary_file_is_rejected_as_a_link(self):
        engine = self._repo_with_alias("src/alias.py", "src/app.py")
        cand = MutationCandidate("alias2", "d", "src/alias.py", "", "y = 2\n")
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertIn("link", cand.verification_output)

    def test_ordinary_source_mutation_still_reaches_verification(self):
        engine = self._repo_with_alias("src/alias.py", "src/app.py")
        cand = MutationCandidate("ok", "d", "src/app.py", "", "y = 2\n")
        self.assertTrue(engine.evaluate_mutation_in_sandbox(cand, "unit"))

    def test_root_level_tests_dir_is_rejected_end_to_end(self):
        engine = self._repo_with_alias("src/alias.py", "src/app.py")
        cand = MutationCandidate("t", "d", "tests/helper.py", "", "x = 2\n")
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertIn("protected", cand.verification_output)

    def test_invalid_input_is_rejected_before_any_resolution(self):
        cand = MutationCandidate("bad", "d", "a.py:stream", "", "x")
        self.assertFalse(self.engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertIn("invalid target", cand.verification_output)


class FakeRunner:
    """Injected VerificationRunner: records calls, optionally mutates the workspace, returns a canned result."""

    def __init__(self, returncode=0, stdout="ok", stderr="", side_effect=None, raises=None):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.side_effect = side_effect
        self.raises = raises
        self.calls = []

    def run(self, *, workspace, profile, timeout):
        self.calls.append({"workspace": Path(workspace), "profile": profile, "timeout": timeout})
        if self.side_effect:
            self.side_effect(Path(workspace))
        if self.raises:
            raise self.raises
        return subprocess.CompletedProcess(args=[profile], returncode=self.returncode, stdout=self.stdout, stderr=self.stderr)


def _make_repo(td):
    repo = Path(td).resolve()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    base = ["git", "-C", str(repo), "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.autocrlf=false"]
    (repo / "src").mkdir()
    (repo / "src" / "app.py").write_bytes(b"a = 1\nb = 2\n")
    (repo / "src" / "other.py").write_bytes(b"c = 3\n")
    subprocess.run(base + ["add", "-A"], check=True)
    subprocess.run(base + ["commit", "-qm", "init"], check=True)
    return repo


class TestVerificationRunnerBoundary(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.repo = _make_repo(self._td.name)

    def _cand(self, cid="c1", code="a = 1\nb = 99\n", target="src/app.py"):
        return MutationCandidate(cid, "d", target, "", code)

    def test_no_runner_configured_rejects_and_runs_no_verification(self):
        from unittest import mock
        engine = _Engine(self.repo)
        cand = self._cand()
        with mock.patch("triad.morphogenetic.subprocess.run") as run:
            self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        run.assert_not_called()
        self.assertIn("isolated verification runner unavailable", cand.verification_output)
        self.assertFalse(cand.survival_passed)

    def test_unsafe_host_runner_requires_explicit_opt_in(self):
        from triad.morphogenetic import UnsafeHostRunner
        with self.assertRaises(ValueError):
            _Engine(self.repo, verification_runner=UnsafeHostRunner({"unit": [sys.executable, "-c", "pass"]}))
        _Engine(
            self.repo,
            verification_runner=UnsafeHostRunner({"unit": [sys.executable, "-c", "pass"]}),
            allow_unsafe_host_runner=True,
        )

    def test_passing_fake_runner_survives_with_a_literal_pathspec_diff(self):
        runner = FakeRunner(returncode=0)
        engine = _Engine(self.repo, verification_runner=runner)
        cand = self._cand()
        self.assertTrue(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertTrue(cand.survival_passed)
        self.assertIn("+b = 99", cand.unified_diff)
        self.assertEqual(runner.calls[0]["profile"], "unit")
        self.assertEqual(runner.calls[0]["timeout"], 120)

    def test_failing_fake_runner_is_apoptosis(self):
        engine = _Engine(self.repo, verification_runner=FakeRunner(returncode=1, stderr="boom"))
        cand = self._cand()
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertFalse(cand.survival_passed)
        self.assertEqual(cand.unified_diff, "")
        self.assertIn("boom", cand.verification_output)

    def test_runner_timeout_is_rejected_not_raised(self):
        runner = FakeRunner(raises=subprocess.TimeoutExpired(cmd="unit", timeout=120))
        engine = _Engine(self.repo, verification_runner=runner)
        cand = self._cand()
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertIn("timed out", cand.verification_output)

    def test_reevaluating_a_survivor_unsuccessfully_clears_stale_state(self):
        engine = _Engine(self.repo, verification_runner=FakeRunner(returncode=0))
        cand = self._cand()
        self.assertTrue(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertTrue(cand.unified_diff)
        engine.verification_runner = FakeRunner(returncode=1)
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertFalse(cand.survival_passed)
        self.assertEqual(cand.unified_diff, "")

    def test_extra_untracked_file_is_rejected_even_when_verification_returns_zero(self):
        runner = FakeRunner(side_effect=lambda ws: (ws / "src" / "dropped.py").write_text("evil = 1\n"))
        engine = _Engine(self.repo, verification_runner=runner)
        cand = self._cand()
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertIn("unexpected", cand.verification_output)
        self.assertFalse(cand.survival_passed)

    def test_modifying_another_tracked_file_is_rejected(self):
        runner = FakeRunner(side_effect=lambda ws: (ws / "src" / "other.py").write_text("c = 'tampered'\n"))
        engine = _Engine(self.repo, verification_runner=runner)
        cand = self._cand()
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertIn("unexpected", cand.verification_output)

    def test_target_rewritten_during_verification_is_rejected_and_never_diffed(self):
        # The scanned/tested candidate is "b = 99"; the runner leaves different bytes in the same file.
        runner = FakeRunner(side_effect=lambda ws: (ws / "src" / "app.py").write_bytes(b"a = 1\nb = 'swapped'\n"))
        engine = _Engine(self.repo, verification_runner=runner)
        cand = self._cand()
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertFalse(cand.survival_passed)
        self.assertEqual(cand.unified_diff, "")
        self.assertIn("target changed during verification", cand.verification_output)

    def test_target_rewritten_then_restored_to_identical_bytes_still_survives(self):
        def touch(ws):
            p = ws / "src" / "app.py"
            p.write_bytes(p.read_bytes())

        engine = _Engine(self.repo, verification_runner=FakeRunner(side_effect=touch))
        cand = self._cand()
        self.assertTrue(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertIn("+b = 99", cand.unified_diff)

    def test_staging_the_target_is_rejected(self):
        def stage(ws):
            subprocess.run(["git", "-C", str(ws), "add", "src/app.py"], check=True)

        engine = _Engine(self.repo, verification_runner=FakeRunner(side_effect=stage))
        cand = self._cand()
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertIn("unexpected", cand.verification_output)

    def test_unsafe_host_runner_uses_a_minimal_environment_and_trusted_profile(self):
        from triad.morphogenetic import UnsafeHostRunner
        os.environ["MORPHO_SENTINEL_SECRET"] = "leak-me"
        self.addCleanup(os.environ.pop, "MORPHO_SENTINEL_SECRET", None)
        script = "import os, sys; sys.exit(7 if 'MORPHO_SENTINEL_SECRET' in os.environ else 0)"
        runner = UnsafeHostRunner({"env-check": [sys.executable, "-c", script]})
        res = runner.run(workspace=self.repo, profile="env-check", timeout=30)
        self.assertEqual(res.returncode, 0, "sentinel variable must not reach the verification process")
        with self.assertRaises(KeyError):
            runner.run(workspace=self.repo, profile="not-a-trusted-profile", timeout=30)


if __name__ == "__main__":
    unittest.main()
