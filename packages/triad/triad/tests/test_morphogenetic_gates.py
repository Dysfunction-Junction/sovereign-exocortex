"""Gates added in row 2.4: default-off flag, diff-size cap, reproduction test."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from triad.morphogenetic import (
    ENABLE_ENV,
    MAX_CHANGED_LINES_ENV,
    MorphogeneticEngine,
    MutationCandidate,
    changed_line_count,
)
from triad.tests.test_morphogenetic import FakeRunner, _make_repo


def _cand(code="a = 1\nb = 99\n", target="src/app.py"):
    return MutationCandidate("c1", "d", target, "", code)


class ScriptedRunner:
    """Returns a scripted exit code for the reproduction profile and for the verification profile."""

    def __init__(self, repro_returncode=1, verify_returncode=0, side_effect=None):
        self.repro_returncode = repro_returncode
        self.verify_returncode = verify_returncode
        self.side_effect = side_effect
        self.calls = []

    def run(self, *, workspace, profile, timeout):
        self.calls.append(profile)
        if self.side_effect and profile == "repro":
            self.side_effect(Path(workspace))
        rc = self.repro_returncode if profile == "repro" else self.verify_returncode
        return subprocess.CompletedProcess(args=[profile], returncode=rc, stdout="", stderr="")


class TestEnableFlag(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.repo = _make_repo(self._td.name)

    def test_default_is_off_and_nothing_runs(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(ENABLE_ENV, None)
            runner = FakeRunner()
            engine = MorphogeneticEngine(self.repo, verification_runner=runner)
            cand = _cand()
            self.assertFalse(engine.enabled)
            self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
            self.assertIn("disabled", cand.verification_output)
            self.assertEqual(runner.calls, [])

    def test_env_flag_and_explicit_argument(self):
        for value, expected in (("1", True), ("true", True), ("0", False), ("", False), ("maybe", False)):
            with mock.patch.dict(os.environ, {ENABLE_ENV: value}):
                self.assertEqual(MorphogeneticEngine(self.repo).enabled, expected, value)
        with mock.patch.dict(os.environ, {ENABLE_ENV: "1"}):
            self.assertFalse(MorphogeneticEngine(self.repo, enabled=False).enabled)
        with mock.patch.dict(os.environ, {ENABLE_ENV: "0"}):
            self.assertTrue(MorphogeneticEngine(self.repo, enabled=True).enabled)


class TestDiffSizeCap(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.repo = _make_repo(self._td.name)

    def test_changed_line_count(self):
        self.assertEqual(changed_line_count("a\nb\n", "a\nb\n"), 0)
        self.assertEqual(changed_line_count("a\nb\n", "a\nc\n"), 2)
        self.assertEqual(changed_line_count("a\n", "a\nb\nc\n"), 2)
        self.assertEqual(changed_line_count("a\r\nb\r\n", "a\nb\n"), 0)

    def test_over_cap_is_rejected_before_anything_runs(self):
        runner = ScriptedRunner()
        engine = MorphogeneticEngine(self.repo, verification_runner=runner, enabled=True, max_changed_lines=10)
        big = "a = 1\nb = 2\n" + "".join(f"x{i} = {i}\n" for i in range(20))
        cand = _cand(big)
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "verify", reproduction_profile="repro"))
        self.assertIn("cap 10", cand.verification_output)
        self.assertEqual(runner.calls, [], "no verification runs for an oversized candidate")

    def test_at_cap_is_accepted(self):
        # one changed line counts as 2 (removed + added), so a cap of 2 allows exactly a one-line edit
        engine = MorphogeneticEngine(self.repo, verification_runner=ScriptedRunner(), enabled=True, max_changed_lines=2)
        self.assertTrue(engine.evaluate_mutation_in_sandbox(_cand(), "verify", reproduction_profile="repro"))

    def test_default_cap_is_200_and_configurable_by_env(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(MAX_CHANGED_LINES_ENV, None)
            self.assertEqual(MorphogeneticEngine(self.repo, enabled=True).max_changed_lines, 200)
        with mock.patch.dict(os.environ, {MAX_CHANGED_LINES_ENV: "50"}):
            self.assertEqual(MorphogeneticEngine(self.repo, enabled=True).max_changed_lines, 50)
        for bad in ("abc", "0", "-5"):
            with mock.patch.dict(os.environ, {MAX_CHANGED_LINES_ENV: bad}):
                self.assertEqual(MorphogeneticEngine(self.repo, enabled=True).max_changed_lines, 200, bad)


class TestReproductionGate(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.repo = _make_repo(self._td.name)

    def _engine(self, runner):
        return MorphogeneticEngine(self.repo, verification_runner=runner, enabled=True)

    def test_requires_a_reproduction_profile_by_default(self):
        runner = ScriptedRunner()
        cand = _cand()
        self.assertFalse(self._engine(runner).evaluate_mutation_in_sandbox(cand, "verify"))
        self.assertIn("reproduction test profile is required", cand.verification_output)
        self.assertEqual(runner.calls, [])

    def test_fails_before_and_passes_after_survives_in_that_order(self):
        runner = ScriptedRunner(repro_returncode=1, verify_returncode=0)
        cand = _cand()
        self.assertTrue(self._engine(runner).evaluate_mutation_in_sandbox(cand, "verify", reproduction_profile="repro"))
        self.assertEqual(runner.calls, ["repro", "verify"])
        self.assertTrue(cand.survival_passed)

    def test_a_test_that_already_passes_proves_nothing(self):
        runner = ScriptedRunner(repro_returncode=0)
        cand = _cand()
        self.assertFalse(self._engine(runner).evaluate_mutation_in_sandbox(cand, "verify", reproduction_profile="repro"))
        self.assertIn("passes before the patch", cand.verification_output)
        self.assertEqual(runner.calls, ["repro"], "the patched tree is never verified")

    def test_still_failing_after_the_patch_is_apoptosis(self):
        runner = ScriptedRunner(repro_returncode=1, verify_returncode=1)
        cand = _cand()
        self.assertFalse(self._engine(runner).evaluate_mutation_in_sandbox(cand, "verify", reproduction_profile="repro"))
        self.assertEqual(runner.calls, ["repro", "verify"])

    def test_reproduction_run_must_not_touch_the_workspace(self):
        def dirty(ws):
            (ws / "stray.txt").write_text("x")

        runner = ScriptedRunner(side_effect=dirty)
        cand = _cand()
        self.assertFalse(self._engine(runner).evaluate_mutation_in_sandbox(cand, "verify", reproduction_profile="repro"))
        self.assertIn("reproduction run changed the workspace", cand.verification_output)
        self.assertEqual(runner.calls, ["repro"])

    def test_can_be_disabled_explicitly_for_callers_without_a_repro(self):
        runner = ScriptedRunner()
        engine = MorphogeneticEngine(self.repo, verification_runner=runner, enabled=True, require_reproduction=False)
        self.assertTrue(engine.evaluate_mutation_in_sandbox(_cand(), "verify"))
        self.assertEqual(runner.calls, ["verify"])


if __name__ == "__main__":
    unittest.main()
