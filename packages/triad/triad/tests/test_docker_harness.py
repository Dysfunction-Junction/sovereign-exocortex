#!/usr/bin/env python3
"""Cache-key and repo-native command tests. These do not start Docker."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from triad.bench.docker_harness import (
    bare_repo_dirname,
    checkout_argv,
    destination_bare_repo,
    django_test_labels,
    docker_outcome,
    native_test_argv,
    resolve_bare_repo,
    runner_executed,
)


class TestDockerHarness(unittest.TestCase):
    def test_dirname_includes_owner(self):
        self.assertEqual(bare_repo_dirname("django/django"), "django__django.git")
        self.assertEqual(bare_repo_dirname("other/django"), "other__django.git")
        self.assertNotEqual(
            bare_repo_dirname("django/django"),
            bare_repo_dirname("other/django"),
        )

    def test_legacy_clone_is_reused_until_owner_key_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            legacy = root / "django.git"
            legacy.mkdir()
            (legacy / "HEAD").write_text("ref: refs/heads/master\n", encoding="utf-8")

            self.assertEqual(resolve_bare_repo(root, "django/django"), legacy)
            self.assertEqual(destination_bare_repo(root, "django/django"), legacy)

            primary = root / "django__django.git"
            primary.mkdir()
            (primary / "HEAD").write_text("ref: refs/heads/master\n", encoding="utf-8")
            self.assertEqual(resolve_bare_repo(root, "django/django"), primary)
            self.assertEqual(destination_bare_repo(root, "django/django"), primary)

    def test_missing_clone_uses_owner_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertIsNone(resolve_bare_repo(root, "django/django"))
            self.assertEqual(
                destination_bare_repo(root, "django/django"),
                root / "django__django.git",
            )

    def test_django_labels_drop_tests_prefix(self):
        labels = django_test_labels(
            ["tests/migrations/test_foo.py::MigrationTests::test_bar"]
        )
        self.assertEqual(labels, ["migrations.test_foo.MigrationTests.test_bar"])

    def test_astropy_argv_requires_prebuilt_image(self):
        old = os.environ.pop("TRIAD_ASTROPY_IMAGE", None)
        try:
            self.assertIsNone(
                native_test_argv("astropy/astropy", ["astropy/tests/test_x.py"])
            )
        finally:
            if old is not None:
                os.environ["TRIAD_ASTROPY_IMAGE"] = old

        argv = native_test_argv("django/django", ["tests/a.py::A::test_b"])
        self.assertEqual(argv[:4], ["python", "tests/runtests.py", "--verbosity", "1"])
        self.assertEqual(argv[4], "a.A.test_b")

    def test_django_unittest_label_from_swebench(self):
        raw = "test_ascii_validator (auth_tests.test_validators.UsernameValidatorsTests)"
        self.assertEqual(
            django_test_labels([raw]),
            ["auth_tests.test_validators.UsernameValidatorsTests.test_ascii_validator"],
        )
        self.assertEqual(django_test_labels(["Named URLs should be reversible"]), [])
        self.assertIsNone(native_test_argv("django/django", ["Named URLs should be reversible"]))
        self.assertIsNone(native_test_argv("django/django", [
            "test_ascii_validator (auth_tests.test_validators.UsernameValidatorsTests)",
            "Named URLs should be reversible",
        ]))

    def test_docker_outcome_trusts_only_a_clean_pass(self):
        self.assertEqual(docker_outcome(0, "OK\nRan 1 test in 0.1s"), "pass")
        self.assertEqual(docker_outcome(0, "OK (skipped=1)\nRan 1 test in 0.1s"), "fallback")
        self.assertEqual(
            docker_outcome(1, "FAILED (failures=1)\nRan 1 test in 0.1s"),
            "fallback",
        )

    def test_runner_executed_ignores_harness_failures(self):
        self.assertFalse(runner_executed(1, "ImportError: No module named django"))
        self.assertFalse(runner_executed(2, "ERROR: file or directory not found"))
        self.assertTrue(runner_executed(1, "FAIL: test_ascii\n\nFAILED (failures=1)\nRan 1 test in 0.1s"))
        self.assertTrue(runner_executed(0, "OK\nRan 1 test in 0.1s"))
        self.assertFalse(
            runner_executed(
                1,
                "ERROR: test_mod (unittest.loader._FailedTest.test_mod)\n"
                "ImportError: Failed to import test module: test_mod\n"
                "Ran 1 test in 0.001s\nFAILED (errors=1)",
            )
        )

    def test_checkout_argv_detaches_at_the_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "origin"
            repo.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "triad@example.com"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Triad"], check=True)
            (repo / "keep.txt").write_text("ok\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "keep.txt"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "pin"], check=True, capture_output=True)
            commit = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
            checkout = root / "src"
            subprocess.run(
                ["git", "clone", "--shared", "--no-checkout", str(repo), str(checkout)],
                check=True, capture_output=True,
            )
            argv = checkout_argv(checkout, commit)
            self.assertLess(argv.index("--detach"), argv.index("--end-of-options"))
            checked = subprocess.run(argv, capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            head = subprocess.run(
                ["git", "-C", str(checkout), "rev-parse", "HEAD"],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
            self.assertEqual(head, commit)


class TestClaudeJudgesCodex(unittest.TestCase):
    def test_codex_does_not_grade_its_own_patch(self):
        from triad.bench.run_bench import _keep_claude_as_judge

        self.assertEqual(_keep_claude_as_judge("codex", "codex"), "claude")
        self.assertEqual(_keep_claude_as_judge("codex", "asymmetric"), "claude")
        self.assertEqual(_keep_claude_as_judge("claude", "claude"), "claude")
        self.assertEqual(_keep_claude_as_judge("auto", "claude"), "claude")

    def test_codex_does_not_grade_after_claude_fails(self):
        from triad.bench.run_bench import _codex_may_grade, _judge_response_failed

        self.assertFalse(_codex_may_grade("codex", "codex"))
        self.assertTrue(_codex_may_grade("claude", "codex"))
        self.assertFalse(_judge_response_failed("The limit field is unchanged. YES"))
        self.assertTrue(_judge_response_failed("[Error: Claude session limit hit]"))
        self.assertTrue(_judge_response_failed("Claude session limit reached"))
        self.assertTrue(_judge_response_failed(""))

    def test_session_limit_prose_is_a_judge_error(self):
        from unittest.mock import patch
        from triad.bench.swebench_runner import verify_semantic_resolution

        with patch("triad.bench.swebench_runner.query_claude", return_value="Claude session limit reached"):
            ok, msg = verify_semantic_resolution(
                {"patch": "", "FAIL_TO_PASS": [], "problem_statement": "x"},
                "",
                "",
                judge_engine="claude",
                author_engine="codex",
            )
        self.assertFalse(ok)
        self.assertIn("Judge error", msg)
        self.assertNotIn("Unresolved", msg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
