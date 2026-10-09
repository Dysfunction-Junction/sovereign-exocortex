"""Unit tests for Triad Intent Engine (intent_engine.py)."""

import sys
import unittest
from pathlib import Path

# Ensure repo root is on sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from triad.intent_engine import classify_intent, is_high_stakes

class TestIntentEngine(unittest.TestCase):

    def test_classify_unified_diff(self):
        sample_diff = (
            "diff --git a/src/auth.ts b/src/auth.ts\n"
            "index abcdef1..1234567 100644\n"
            "--- a/src/auth.ts\n"
            "+++ b/src/auth.ts\n"
            "@@ -10,4 +10,5 @@\n"
            "+ const userToken = jwt.sign();\n"
        )
        res = classify_intent("Check these modifications", diff=sample_diff)
        self.assertEqual(res.intent, "REVIEW")
        self.assertGreaterEqual(res.confidence, 0.90)
        self.assertEqual(res.suggested_mode, "review_diff")
        self.assertTrue(res.high_stakes) # auth + jwt
        self.assertEqual(res.suggested_engine, "competition")

    def test_classify_stack_trace(self):
        err_msg = (
            "Traceback (most recent call last):\n"
            "  File \"main.py\", line 42, in <module>\n"
            "    res = process_payment(order)\n"
            "TypeError: Cannot read properties of undefined (reading 'amount')"
        )
        res = classify_intent(err_msg)
        self.assertEqual(res.intent, "DEBUG")
        self.assertGreaterEqual(res.confidence, 0.90)
        self.assertEqual(res.suggested_mode, "debug")

    def test_classify_gate(self):
        res = classify_intent("Run pre-commit verification before pushing")
        self.assertEqual(res.intent, "GATE")
        self.assertEqual(res.suggested_mode, "gate")
        self.assertGreaterEqual(res.confidence, 0.90)

    def test_classify_device(self):
        res = classify_intent("Send an SMS from my phone to check status")
        self.assertEqual(res.intent, "DEVICE")
        self.assertEqual(res.suggested_engine, "hermes")
        self.assertGreaterEqual(res.confidence, 0.90)

    def test_classify_memory(self):
        res = classify_intent("What did I do on the Pieces Android companion yesterday?")
        self.assertEqual(res.intent, "MEMORY")
        self.assertEqual(res.suggested_engine, "pieces")
        self.assertGreaterEqual(res.confidence, 0.85)

    def test_classify_mesh(self):
        res = classify_intent("Check the agent mesh status and peer channels")
        self.assertEqual(res.intent, "MESH")
        self.assertEqual(res.suggested_mode, "mesh")
        self.assertEqual(res.suggested_engine, "mesh")
        self.assertGreaterEqual(res.confidence, 0.90)

    def test_classify_doctor(self):
        res = classify_intent("triad doctor check system health and subscriptions")
        self.assertEqual(res.intent, "DOCTOR")
        self.assertEqual(res.suggested_mode, "doctor")

    def test_classify_architect_comparison(self):
        res = classify_intent("Should we use optimistic UI or server-confirmed state for this queue?")
        self.assertEqual(res.intent, "ARCHITECT")
        self.assertEqual(res.suggested_mode, "architect")

    def test_bare_question_is_general(self):
        res = classify_intent("Is this on line 42?")
        self.assertEqual(res.intent, "GENERAL")
        self.assertEqual(res.suggested_mode, "general")
        self.assertFalse(res.high_stakes)

    def test_high_stakes_general_routes_to_competition(self):
        # A general query with high-stakes keywords (jwt, auth) must route to competition
        res = classify_intent("How should we design JWT auth tokens?")
        self.assertEqual(res.intent, "GENERAL")
        self.assertTrue(res.high_stakes)
        self.assertEqual(res.suggested_engine, "competition")

    def test_typo_guard_and_natural_language_dispatch(self):
        from triad.triad_engine import is_plausible_natural_language
        known = {"doctor", "review", "consult", "debug", "gate", "bench", "worktree", "auto"}
        
        # Near-miss typos must be rejected
        self.assertFalse(is_plausible_natural_language("revew", 2, known))
        self.assertFalse(is_plausible_natural_language("revew", 4, known))
        self.assertFalse(is_plausible_natural_language("gaet", 3, known))
        self.assertFalse(is_plausible_natural_language("docter", 2, known))

        # Unknown single-word commands must be rejected
        self.assertFalse(is_plausible_natural_language("foo", 2, known))
        self.assertFalse(is_plausible_natural_language("bar", 2, known))

        # Real natural language and queries must be accepted
        self.assertTrue(is_plausible_natural_language("why is this failing", 5, known))
        self.assertTrue(is_plausible_natural_language("Is this on line 42?", 2, known))
        self.assertTrue(is_plausible_natural_language("path/to/file.py", 2, known))
        self.assertTrue(is_plausible_natural_language("review this diff for bugs", 6, known))

    def test_high_stakes_detection(self):
        self.assertTrue(is_high_stakes("Need to execute database migration with row level security"))
        self.assertTrue(is_high_stakes("Fixing race condition and deadlock in pool"))
        self.assertFalse(is_high_stakes("Change background color of button to blue"))

    def test_review_beats_device_keywords(self):
        """Code review of mobile code must not be forwarded to the phone bridge."""
        res = classify_intent("review the android SMS notification handler")
        self.assertEqual(res.intent, "REVIEW")
        self.assertEqual(res.suggested_mode, "review_diff")
        self.assertNotEqual(res.suggested_engine, "hermes")

    def test_architect_beats_device_for_comparisons(self):
        res = classify_intent("compare these android SMS approaches")
        self.assertEqual(res.intent, "ARCHITECT")
        self.assertEqual(res.suggested_mode, "architect")

    def test_gate_still_beats_review_when_both_match(self):
        res = classify_intent("review this pre-commit verification before pushing")
        self.assertEqual(res.intent, "GATE")

    def test_high_stakes_hyphenated_compounds(self):
        self.assertTrue(is_high_stakes("fix auth-token race"))
        self.assertTrue(is_high_stakes("update db-migration script"))

    def test_debugging_inflection(self):
        res = classify_intent("debugging the queue")
        self.assertEqual(res.intent, "DEBUG")

    def test_micro_task_routing(self):
        res = classify_intent("format this file and sort imports")
        self.assertEqual(res.intent, "MICRO")
        self.assertEqual(res.suggested_engine, "ollama")

    def test_bare_token_and_migration_not_high_stakes(self):
        self.assertFalse(is_high_stakes("design tokens for the landing page"))
        self.assertFalse(is_high_stakes("migration guide documentation"))
        self.assertTrue(is_high_stakes("validate access token"))
        self.assertTrue(is_high_stakes("run database migration"))

    def test_gate_beats_micro(self):
        res = classify_intent("run pre-commit and sort imports")
        self.assertEqual(res.intent, "GATE")

    def test_high_stakes_beats_micro(self):
        res = classify_intent("generate docstring for the auth token verifier")
        self.assertTrue(res.high_stakes)
        self.assertNotEqual(res.intent, "MICRO")

    def test_gate_beats_debug(self):
        res = classify_intent("run pre-commit verification and fix debugging issues")
        self.assertEqual(res.intent, "GATE")


if __name__ == "__main__":
    unittest.main()
