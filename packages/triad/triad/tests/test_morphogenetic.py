#!/usr/bin/env python3
"""
Unit tests for Frontier 3 Morphogenetic Software Engine (test_morphogenetic.py).
"""

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


if __name__ == "__main__":
    unittest.main()
