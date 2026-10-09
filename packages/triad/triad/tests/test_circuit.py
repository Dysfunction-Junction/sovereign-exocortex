#!/usr/bin/env python3
"""Unit tests for the persistent advisor circuit breaker and auto-failover skips."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from triad.circuit import (
    record_failure,
    record_success,
    is_circuit_open,
    circuit_remaining,
    circuit_reason,
    reset_circuit,
    snapshot_circuits,
)
from triad.procutil import classify_advisor_response, is_failed_advisor_response
from triad.advisor_manager import (
    query_configured_advisor,
    is_test_advisor,
    advisor_is_ready,
    save_config,
)
from triad.competition import select_competition_pair, query_competition_council


def _child_circuit_worker(circuit_path: str, advisor_name: str, count: int) -> None:
    os.environ["TRIAD_CIRCUIT"] = "1"
    os.environ["TRIAD_CIRCUIT_PATH"] = str(circuit_path)
    from triad.circuit import record_failure, record_success
    for _ in range(count):
        record_failure(advisor_name, "error")
        record_success(advisor_name)


class CircuitIsolationMixin:
    def _isolate_circuit(self):
        self._tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self._tmp.close()
        self._path = Path(self._tmp.name)
        self._env = patch.dict(os.environ, {
            "TRIAD_CIRCUIT": "1",
            "TRIAD_CIRCUIT_PATH": str(self._path),
            "TRIAD_CIRCUIT_LIMIT_SECONDS": "30",
            "TRIAD_CIRCUIT_ERROR_SECONDS": "10",
            "TRIAD_CIRCUIT_TIMEOUT_SECONDS": "10",
        })
        self._env.start()
        self.addCleanup(self._env.stop)
        self.addCleanup(lambda: self._path.exists() and self._path.unlink())


class TestCircuitBreaker(CircuitIsolationMixin, unittest.TestCase):
    def setUp(self):
        self._isolate_circuit()

    def test_limit_opens_and_success_closes(self):
        self.assertFalse(is_circuit_open("claude"))
        record_failure("claude", "limit")
        self.assertTrue(is_circuit_open("claude"))
        self.assertEqual(circuit_reason("claude"), "limit")
        self.assertGreater(circuit_remaining("claude"), 0)
        record_success("claude")
        self.assertFalse(is_circuit_open("claude"))
        snap = snapshot_circuits()
        self.assertEqual(snap["advisors"]["claude"]["state"], "closed")
        self.assertEqual(snap["advisors"]["claude"]["failures"], 0)

    def test_error_backoff_grows(self):
        record_failure("codex", "error")
        self.assertFalse(is_circuit_open("codex"))  # 1st failure: remains closed
        record_failure("codex", "error")
        self.assertTrue(is_circuit_open("codex"))   # 2nd failure: trips breaker
        first = circuit_remaining("codex")
        record_failure("codex", "error")
        second = circuit_remaining("codex")
        self.assertGreater(second, first)

    def test_reset_clears_state(self):
        record_failure("nous", "limit")
        self.assertTrue(is_circuit_open("nous"))
        reset_circuit("nous")
        self.assertFalse(is_circuit_open("nous"))

    def test_disabled_never_opens(self):
        with patch.dict(os.environ, {"TRIAD_CIRCUIT": "0"}):
            record_failure("claude", "limit")
            self.assertFalse(is_circuit_open("claude"))

    def test_state_persists_to_disk(self):
        record_failure("claude", "limit")
        with open(self._path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertIn("claude", data)
        self.assertEqual(data["claude"]["reason"], "limit")

    def test_stale_failure_after_newer_success_dropped(self):
        import time
        t0 = time.time()
        # Newer request starts at t0 + 2 and succeeds
        record_success("claude", call_start_time=t0 + 2)
        self.assertFalse(is_circuit_open("claude"))

        # Older lagged request that started at t0 fails with limit
        record_failure("claude", "limit", call_start_time=t0)
        # Breaker must NOT open because a newer request already succeeded
        self.assertFalse(is_circuit_open("claude"))

    def test_stale_success_does_not_clear_newer_transient_failure(self):
        import time
        t0 = time.time()
        # Newer request fails at t0 + 2
        record_failure("codex", "error", call_start_time=t0 + 2)
        snap = snapshot_circuits()
        self.assertEqual(snap["advisors"]["codex"]["failures"], 1)

        # Older request that started at t0 completes successfully
        record_success("codex", call_start_time=t0)
        snap2 = snapshot_circuits()
        # Must preserve the newer failure streak so the next failure trips
        self.assertEqual(snap2["advisors"]["codex"]["failures"], 1)

        # Another error occurs
        record_failure("codex", "error", call_start_time=t0 + 4)
        self.assertTrue(is_circuit_open("codex"))

    def test_track_circuit_false_ignored(self):
        record_failure("claude", "limit", track_circuit=False)
        self.assertFalse(is_circuit_open("claude"))

    def test_concurrent_writes_thread_safe(self):
        import concurrent.futures
        def worker(name):
            for _ in range(5):
                record_failure(name, "limit")
                record_success(name)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
            futures = [ex.submit(worker, f"adv_{i}") for i in range(4)]
            for f in futures:
                f.result()
        snap = snapshot_circuits()
        self.assertTrue(snap["enabled"])

    def test_multiprocess_circuit_concurrency(self):
        import multiprocessing
        processes = []
        for i in range(3):
            p = multiprocessing.Process(
                target=_child_circuit_worker,
                args=(str(self._path), f"mp_adv_{i}", 4)
            )
            p.start()
            processes.append(p)
        for p in processes:
            p.join(timeout=10)
            self.assertEqual(p.exitcode, 0)

        snap = snapshot_circuits()
        self.assertTrue(snap["enabled"])
        for i in range(3):
            self.assertIn(f"mp_adv_{i}", snap["advisors"])
            self.assertEqual(snap["advisors"][f"mp_adv_{i}"]["state"], "closed")

    def test_contention_lock_timeout_skips_unlocked_mutation(self):
        from triad.circuit import _interprocess_file_lock
        # Hold the interprocess file lock in a context
        with _interprocess_file_lock() as outer_acquired:
            self.assertTrue(outer_acquired)
            # A nested call with short timeout will fail acquisition
            with _interprocess_file_lock(timeout=0.05) as inner_acquired:
                self.assertFalse(inner_acquired)

    def test_record_failure_and_success_handle_lock_timeout_without_raising(self):
        import contextlib
        from unittest.mock import patch
        from triad.circuit import record_failure, record_success

        @contextlib.contextmanager
        def _mock_lock_fail(*args, **kwargs):
            yield False

        with patch("triad.circuit._interprocess_file_lock", _mock_lock_fail):
            # Must not raise NameError (e.g. sys.stderr) or any exception on failure to acquire lock
            record_failure("claude", "error")
            record_success("claude")

    def test_active_rate_limit_cooldown_preserved(self):
        import time
        now = time.time()
        record_failure("claude", "limit")
        rem_limit = circuit_remaining("claude")
        self.assertTrue(is_circuit_open("claude"))
        self.assertGreater(rem_limit, 20)

        # Subsequent transient error must not shorten the 30s limit cooldown to 10s
        record_failure("claude", "error")
        rem_after_error = circuit_remaining("claude")
        self.assertGreater(rem_after_error, 20)
        self.assertEqual(circuit_reason("claude"), "limit")

        # Stale success from a call that started before the limit occurred must not clear it
        record_success("claude", call_start_time=now - 5)
        self.assertTrue(is_circuit_open("claude"))
        self.assertEqual(circuit_reason("claude"), "limit")

    def test_overlapping_requests_order(self):
        # A starts at 100, B starts at 110.
        # A succeeds at 120. B fails at 130.
        # B's failure started at 110 (after A's start at 100), so B is a newer request and must NOT be discarded.
        reset_circuit("claude")
        record_success("claude", call_start_time=100.0)
        self.assertFalse(is_circuit_open("claude"))

        # B started at 110.0 and hits limit
        record_failure("claude", "limit", call_start_time=110.0)
        self.assertTrue(is_circuit_open("claude"))
        self.assertEqual(circuit_reason("claude"), "limit")

        # C started at 90.0 (prior to A's start at 100.0) and fails with error at 140.0
        # C is older than A's success, so C's failure must be discarded as stale
        reset_circuit("codex")
        record_success("codex", call_start_time=100.0)
        record_failure("codex", "error", call_start_time=90.0)
        from triad.circuit import _load
        codex_data = _load().get("codex", {})
        self.assertEqual(codex_data.get("failures", 0), 0)

    def test_streak_decay_resets_streak(self):
        import time
        record_failure("test_adv", "error")
        self.assertFalse(is_circuit_open("test_adv"))

        # Mutate last_failure to be 1000s in the past
        from triad.circuit import _load, _save
        data = _load()
        data["test_adv"]["last_failure"] = time.time() - 1000
        _save(data)

        # Second failure now should NOT trip because previous failure decayed
        record_failure("test_adv", "error")
        self.assertFalse(is_circuit_open("test_adv"))


class TestClassifyTimeout(unittest.TestCase):
    def test_timeout_tag(self):
        text = "[Error: Claude 3.7 Sonnet timed out after 120s (process tree killed)]"
        self.assertEqual(classify_advisor_response(text), "timeout")
        self.assertTrue(is_failed_advisor_response(text))

    def test_limit_still_limit(self):
        self.assertEqual(
            classify_advisor_response("[Claude Session Limit]: 5-hour window"),
            "limit",
        )

    def test_review_mentioning_error_not_classified_as_error(self):
        text = "[Error handling in auth.py]: Looks solid, but make sure to log the exception."
        self.assertEqual(classify_advisor_response(text), "ok")
        self.assertFalse(is_failed_advisor_response(text))


class TestAdvisorReadinessAndMockIsolation(CircuitIsolationMixin, unittest.TestCase):
    def setUp(self):
        self._isolate_circuit()

    def test_is_test_advisor(self):
        self.assertTrue(is_test_advisor({"name": "mock"}))
        self.assertTrue(is_test_advisor({"name": "custom", "role": "test"}))
        self.assertFalse(is_test_advisor({"name": "claude"}))

    def test_auto_does_not_fall_through_to_mock(self):
        with tempfile.NamedTemporaryFile(mode="w+", suffix=".json", delete=False, encoding="utf-8") as tf:
            config_path = Path(tf.name)
        self.addCleanup(lambda: config_path.exists() and config_path.unlink())
        save_config({
            "advisors": [
                {
                    "name": "failing_primary",
                    "display_name": "Failing Primary",
                    "binary_path": "python",
                    "priority": 1,
                    "execution_flags": ["-c", "import sys; sys.stderr.write('Rate limit exceeded'); sys.exit(1)"],
                    "enabled": True,
                },
                {
                    "name": "mock",
                    "display_name": "Mock Test Advisor",
                    "role": "test",
                    "binary_path": "python",
                    "priority": 99,
                    "execution_flags": ["-c", "import sys; sys.stdout.write('VERDICT: APPROVED\\n[Mock Advisor]: Approved')"],
                    "enabled": True,
                },
            ]
        }, config_path)
        resp = query_configured_advisor("auto", "pre-commit verification", config_path=config_path)
        self.assertIn("Auto-Failover Exhausted", resp)
        self.assertNotIn("VERDICT: APPROVED", resp)
        self.assertNotIn("[Mock Advisor]", resp)

    def test_auto_skips_open_circuit(self):
        record_failure("failing_primary", "limit")
        with tempfile.NamedTemporaryFile(mode="w+", suffix=".json", delete=False, encoding="utf-8") as tf:
            config_path = Path(tf.name)
        self.addCleanup(lambda: config_path.exists() and config_path.unlink())
        save_config({
            "advisors": [
                {
                    "name": "failing_primary",
                    "display_name": "Should Be Skipped",
                    "binary_path": "python",
                    "priority": 1,
                    "execution_flags": ["-c", "import sys; sys.stdout.write('SHOULD_NOT_RUN'); sys.exit(0)"],
                    "enabled": True,
                },
                {
                    "name": "backup_secondary",
                    "display_name": "Backup Secondary",
                    "binary_path": "python",
                    "priority": 2,
                    "execution_flags": ["-c", "import sys; sys.stdout.write('BACKUP_REACHED')"],
                    "enabled": True,
                },
            ]
        }, config_path)
        resp = query_configured_advisor("auto", "hello", config_path=config_path)
        self.assertIn("BACKUP_REACHED", resp)
        self.assertNotIn("SHOULD_NOT_RUN", resp)
        self.assertIn("Advisor Auto-Failover", resp)

    def test_readiness_port_closed_skips(self):
        with tempfile.NamedTemporaryFile(mode="w+", suffix=".json", delete=False, encoding="utf-8") as tf:
            config_path = Path(tf.name)
        self.addCleanup(lambda: config_path.exists() and config_path.unlink())
        save_config({
            "advisors": [
                {
                    "name": "local_down",
                    "display_name": "Down Local",
                    "binary_path": "python",
                    "priority": 1,
                    "execution_flags": ["-c", "import sys; sys.stdout.write('DOWN_RAN')"],
                    "readiness_port": 1,
                    "enabled": True,
                },
                {
                    "name": "backup_secondary",
                    "display_name": "Backup Secondary",
                    "binary_path": "python",
                    "priority": 2,
                    "execution_flags": ["-c", "import sys; sys.stdout.write('BACKUP_REACHED')"],
                    "enabled": True,
                },
            ]
        }, config_path)
        resp = query_configured_advisor("auto", "hello", config_path=config_path)
        self.assertIn("BACKUP_REACHED", resp)
        self.assertNotIn("DOWN_RAN", resp)

    def test_advisor_is_ready_missing_binary(self):
        ready, why = advisor_is_ready({
            "name": "ghost",
            "binary_path": "definitely-not-a-real-binary-xyz",
            "fallback_binary": "also-not-real-abc",
        })
        self.assertFalse(ready)
        self.assertIn("binary not found", why)

    def test_explicit_mock_still_works(self):
        resp = query_configured_advisor("mock", "Hello from circuit test")
        self.assertIn("[Mock Advisor]", resp)


class TestCompetitionCircuitAwareness(CircuitIsolationMixin, unittest.TestCase):
    def setUp(self):
        self._isolate_circuit()

    def test_select_pair_skips_open_circuit(self):
        record_failure("claude", "limit")
        advisors = [
            {"name": "claude", "enabled": True, "priority": 1, "binary_path": "python"},
            {"name": "codex", "enabled": True, "priority": 2, "binary_path": "python"},
            {"name": "nous", "enabled": True, "priority": 3, "binary_path": "python"},
            {"name": "mock", "enabled": True, "priority": 99, "role": "test", "binary_path": "python"},
        ]
        with patch("triad.competition.get_advisors", return_value=advisors), \
             patch("triad.advisor_manager.get_advisors", return_value=advisors):
            pair, ok = select_competition_pair(("claude", "codex"))
        self.assertTrue(ok)
        self.assertNotIn("claude", pair)
        self.assertEqual(pair[0], "codex")
        self.assertEqual(pair[1], "nous")

    def test_skips_synthesis_when_both_fail(self):
        with patch("triad.competition.query_configured_advisor") as q:
            q.side_effect = [
                "[Error from mock]: fail",
                "[Error from mock]: fail",
                "SHOULD_NOT_RUN",
            ]
            res = query_competition_council("x", advisor_names=("mock", "mock"))
        self.assertEqual(q.call_count, 2)
        self.assertIn("Both advisors failed", res["synthesis"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
