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


class TestMorphogeneticEngine(unittest.TestCase):
    def setUp(self):
        self.repo_root = Path(__file__).resolve().parents[4]
        self.engine = MorphogeneticEngine(self.repo_root)

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
            target_file="packages/core/package.json",
            original_code="{}",
            mutated_code='{"dependency": "deprecated_root_api"}',
        )

        survived = self.engine.evaluate_mutation_in_sandbox(
            candidate,
            verification_command=["git", "status"],
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
            verification_command=["git", "status"],
        )
        self.assertFalse(survived)
        self.assertIn("escapes sandbox", candidate.verification_output)
        self.assertFalse(outside_path.exists(), "Target file must not be created outside sandbox")

    def test_noop_mutation_rejection(self):
        # Read hermetically from git HEAD to avoid uncommitted working tree differences
        res = subprocess.run(
            ["git", "show", "HEAD:package.json"],
            cwd=str(self.repo_root),
            capture_output=True,
            text=True,
        )
        head_pkg_content = res.stdout

        candidate = MutationCandidate(
            candidate_id="noop_mut",
            description="No-op mutation with different newline endings",
            target_file="package.json",
            original_code="",
            # Test that newline normalization (CRLF vs LF) correctly detects no-op
            mutated_code=head_pkg_content.replace("\n", "\r\n"),
        )
        survived = self.engine.evaluate_mutation_in_sandbox(
            candidate,
            verification_command=["git", "status"],
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

            engine = MorphogeneticEngine(repo)
            candidate = MutationCandidate(
                candidate_id="eol",
                description="single line change",
                target_file="f.py",
                original_code="",
                mutated_code="a = 1" + NL + "b = 99" + NL + "c = 3" + NL,
            )
            self.assertTrue(engine.evaluate_mutation_in_sandbox(candidate, [sys.executable, "-c", "pass"]))
            changed = [l for l in candidate.unified_diff.splitlines() if l[:1] in "+-" and l[:3] not in ("+++", "---")]
            self.assertEqual(changed, ["-b = 2", "+b = 99"])


if __name__ == "__main__":
    unittest.main()
