#!/usr/bin/env python3
"""
Unit tests for Triad Phone Notification Bridge (triad/notifier.py).
Verifies:
- Push dispatch to Bear House Classic /api/triad-notify
- IFTTT webhook fallback dispatch
- Safe, non-blocking failure modes when all targets are unreachable
- Status icon formatting
"""

import json
import os
import unittest
import threading
from unittest.mock import patch, MagicMock

from triad.notifier import notify_event


class TestTriadNotifier(unittest.TestCase):
    @patch("urllib.request.urlopen")
    def test_notify_bear_house_success(self, mock_urlopen):
        """Verify successful push dispatch to Bear House Classic."""
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        result = notify_event("Test Title", "Test Body", status="success")
        self.assertTrue(result)

        # Inspect request
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_method(), "POST")
        self.assertTrue(req.full_url.endswith("/api/triad-notify"))
        payload = json.loads(req.data.decode("utf-8"))
        self.assertEqual(payload["title"], "✓ Test Title")
        self.assertEqual(payload["body"], "Test Body")
        self.assertEqual(payload["status"], "success")

    @patch("urllib.request.urlopen")
    def test_notify_bear_house_accepted_202(self, mock_urlopen):
        """Verify 202 Accepted is treated as valid endpoint acceptance without failing over to IFTTT."""
        mock_resp = MagicMock()
        mock_resp.status = 202
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        result = notify_event("Async Job", "Accepted for processing", status="info")
        self.assertTrue(result)
        self.assertEqual(mock_urlopen.call_count, 1)

    @patch.dict(os.environ, {"IFTTT_WEBHOOKS_KEY": "fake-ifttt-key"})
    @patch("urllib.request.urlopen")
    def test_notify_fallback_to_ifttt(self, mock_urlopen):
        """Verify fallback to IFTTT when Bear House is unreachable."""
        # 1st call (Bear House) fails, 2nd call (IFTTT) succeeds
        mock_ifttt_resp = MagicMock()
        mock_ifttt_resp.status = 200
        mock_ifttt_resp.__enter__.return_value = mock_ifttt_resp

        mock_urlopen.side_effect = [
            Exception("Connection refused"),
            mock_ifttt_resp
        ]

        result = notify_event("Alert", "Something broke", status="error")
        self.assertTrue(result)
        self.assertEqual(mock_urlopen.call_count, 2)

        ifttt_req = mock_urlopen.call_args_list[1][0][0]
        self.assertIn("maker.ifttt.com", ifttt_req.full_url)
        payload = json.loads(ifttt_req.data.decode("utf-8"))
        self.assertEqual(payload["value1"], "❌ Alert")

    @patch.dict(os.environ, {"IFTTT_WEBHOOKS_KEY": "fake-ifttt-key"})
    @patch("urllib.request.urlopen")
    def test_notify_fallback_executes_when_bear_house_times_out(self, mock_urlopen):
        """[Round 7 Finding 5] Verify IFTTT fallback executes even when Bear House hangs and times out."""
        import time

        mock_ifttt_resp = MagicMock()
        mock_ifttt_resp.status = 200
        mock_ifttt_resp.__enter__.return_value = mock_ifttt_resp

        def side_effect(req, timeout=None):
            if "triad-notify" in req.full_url:
                time.sleep(0.06)
                raise TimeoutError("Bear House timed out")
            return mock_ifttt_resp

        mock_urlopen.side_effect = side_effect

        result = notify_event("Timeout Fallback", "Testing timeout budget split", status="info", timeout=0.2)
        self.assertTrue(result)
        self.assertEqual(mock_urlopen.call_count, 2)
        self.assertIn("maker.ifttt.com", mock_urlopen.call_args_list[1][0][0].full_url)

    @patch("urllib.request.urlopen", side_effect=Exception("Network down"))
    def test_notify_fails_gracefully(self, mock_urlopen):
        """Verify notify_event returns False cleanly and never raises exceptions."""
        result = notify_event("Offline", "Offline body", status="info")
        self.assertFalse(result)

    def setUp(self):
        import triad.notifier as tn
        tn._dispatch_semaphore = threading.BoundedSemaphore(tn.MAX_CONCURRENT_NOTIFICATIONS)
        with tn._active_threads_lock:
            tn._active_threads.clear()

    def tearDown(self):
        import triad.notifier as tn
        tn.flush_notifications(timeout=2.0)
        with tn._active_threads_lock:
            for t in list(tn._active_threads):
                try:
                    t.join(timeout=0.5)
                except Exception:
                    pass
            tn._active_threads.clear()
        tn._dispatch_semaphore = threading.BoundedSemaphore(tn.MAX_CONCURRENT_NOTIFICATIONS)

    @patch("threading.Thread")
    def test_notify_async_dispatch(self, mock_thread_cls):
        """Verify async_dispatch spawns a daemon thread without blocking."""
        mock_thread_instance = MagicMock()
        mock_thread_cls.return_value = mock_thread_instance

        result = notify_event("Async Title", "Async Body", async_dispatch=True)
        self.assertTrue(result)
        mock_thread_cls.assert_called_once()
        self.assertTrue(mock_thread_cls.call_args[1].get("daemon"))
        mock_thread_instance.start.assert_called_once()

    @patch("threading.Thread")
    def test_notify_async_start_failure_does_not_register_thread(self, mock_thread_cls):
        """Verify that if Thread.start() raises, thread is not leaked in _active_threads."""
        from triad.notifier import _active_threads, _active_threads_lock
        mock_thread_instance = MagicMock()
        mock_thread_instance.start.side_effect = RuntimeError("Failed to start thread")
        mock_thread_cls.return_value = mock_thread_instance

        result = notify_event("Failing Start", "Body", async_dispatch=True)
        self.assertFalse(result)
        with _active_threads_lock:
            self.assertNotIn(mock_thread_instance, _active_threads)

    def test_flush_notifications(self):
        """Verify flush_notifications joins all registered pending threads."""
        from triad.notifier import flush_notifications, _active_threads, _active_threads_lock
        mock_thread = MagicMock()
        with _active_threads_lock:
            _active_threads.append(mock_thread)
        try:
            flush_notifications(timeout=0.5)
            mock_thread.join.assert_called_once()
        finally:
            with _active_threads_lock:
                if mock_thread in _active_threads:
                    _active_threads.remove(mock_thread)

    def test_flush_notifications_monotonic_timeout(self):
        """Verify flush_notifications terminates within bounded monotonic timeout."""
        import time
        from triad.notifier import flush_notifications, _active_threads, _active_threads_lock
        mock_thread = MagicMock()
        # Mock join that blocks indefinitely unless timeout is respected
        def blocking_join(timeout=None):
            time.sleep(0.05)
        mock_thread.join.side_effect = blocking_join

        with _active_threads_lock:
            _active_threads.append(mock_thread)
        t0 = time.monotonic()
        flush_notifications(timeout=0.08)
        t1 = time.monotonic()
        self.assertLess(t1 - t0, 0.5)

    @patch("urllib.request.urlopen")
    def test_concurrent_start_and_flush(self, mock_urlopen):
        """Verify concurrent worker dispatch and flush without leaving mocked threads registered."""
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        import threading, time
        from triad.notifier import flush_notifications, _active_threads, _active_threads_lock

        errors = []
        def spawn_workers():
            for _ in range(8):
                try:
                    notify_event("Concurrent Title", "Concurrent Body", status="info", async_dispatch=True, timeout=0.1)
                    time.sleep(0.005)
                except Exception as e:
                    errors.append(e)

        producer_threads = [threading.Thread(target=spawn_workers) for _ in range(3)]
        flusher_thread = threading.Thread(target=lambda: flush_notifications(timeout=2.0))

        # Start producers and flusher concurrently to exercise overlapping registration & flushing
        for t in producer_threads:
            t.start()
        flusher_thread.start()

        for t in producer_threads:
            t.join()
        flusher_thread.join()

        self.assertEqual(errors, [])
        # Final flush to ensure any thread registered right before producer completion is joined
        flush_notifications(timeout=2.0)
        with _active_threads_lock:
            self.assertEqual(len(_active_threads), 0)

    @patch("urllib.request.urlopen")
    def test_dispatch_sync_bounded_timeout(self, mock_urlopen):
        """[Round 5 Finding 5] Verify _dispatch_sync terminates within bounded timeout when remote server hangs."""
        import time
        from triad.notifier import _dispatch_sync

        def hanging_urlopen(*args, **kwargs):
            time.sleep(0.3)
            raise TimeoutError("Simulated hang")

        mock_urlopen.side_effect = hanging_urlopen

        t0 = time.monotonic()
        res = _dispatch_sync("Hanging", "Body", status="info", timeout=0.1)
        t1 = time.monotonic()

        self.assertFalse(res)
        self.assertLess(t1 - t0, 0.8, "Sync dispatch must be strictly bounded by timeout")

    @patch("urllib.request.urlopen")
    def test_flush_waits_for_network_completion_after_dispatch_timeout(self, mock_urlopen):
        """[Round 5 Finding 4] Verify flush_notifications waits for delivery completing after dispatch timeout but within flush budget."""
        import time
        from triad.notifier import notify_event, flush_notifications, _active_threads, _active_threads_lock

        delivery_completed = [False]
        def slow_successful_urlopen(*args, **kwargs):
            # Delivery takes 0.15s, longer than dispatch timeout (0.05s) but well within flush budget (1.0s)
            time.sleep(0.15)
            mock_resp = MagicMock()
            mock_resp.status = 200
            mock_resp.__enter__.return_value = mock_resp
            delivery_completed[0] = True
            return mock_resp

        mock_urlopen.side_effect = slow_successful_urlopen

        # Sync dispatch with very short timeout times out on the foreground join
        res = notify_event("Slow Delivery", "Body", status="info", timeout=0.05, async_dispatch=False)
        self.assertFalse(res, "Foreground join must time out")
        self.assertFalse(delivery_completed[0], "Delivery not yet completed at foreground timeout")

        # But the actual network thread is tracked in _active_threads, so flush_notifications will wait and let it finish!
        with _active_threads_lock:
            self.assertEqual(len(_active_threads), 1)

        t0 = time.monotonic()
        flush_notifications(timeout=1.0)
        t1 = time.monotonic()

        self.assertTrue(delivery_completed[0], "Delivery must complete during flush_notifications")
        with _active_threads_lock:
            self.assertEqual(len(_active_threads), 0)
        self.assertLess(t1 - t0, 0.9)

    @patch("urllib.request.urlopen")
    def test_notification_concurrency_is_strictly_bounded(self, mock_urlopen):
        """[Round 5 Finding 4] Verify notification concurrency is strictly bounded by MAX_CONCURRENT_NOTIFICATIONS."""
        import threading, time
        from triad.notifier import notify_event, flush_notifications, MAX_CONCURRENT_NOTIFICATIONS

        in_flight = []
        max_seen = [0]
        lock = threading.Lock()

        def slow_urlopen(*args, **kwargs):
            with lock:
                in_flight.append(1)
                if len(in_flight) > max_seen[0]:
                    max_seen[0] = len(in_flight)
            time.sleep(0.08)
            with lock:
                in_flight.pop()
            mock_resp = MagicMock()
            mock_resp.status = 200
            mock_resp.__enter__.return_value = mock_resp
            return mock_resp

        mock_urlopen.side_effect = slow_urlopen

        threads = [
            threading.Thread(target=lambda: notify_event("Burst", "Body", async_dispatch=True, timeout=0.5))
            for _ in range(20)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertLessEqual(max_seen[0], MAX_CONCURRENT_NOTIFICATIONS)
        flush_notifications(timeout=2.0)

    @patch("urllib.request.urlopen")
    def test_notification_deadline_prevents_late_delivery(self, mock_urlopen):
        """[Round 5 Finding 5] Verify that a notification whose deadline has expired does not perform late network I/O."""
        import time
        import triad.notifier as tn
        from triad.notifier import _network_delivery_worker

        past_deadline = time.monotonic() - 1.0
        outcome = [False]
        # Acquire permit first so worker release does not raise BoundedSemaphore overflow
        self.assertTrue(tn._dispatch_semaphore.acquire(blocking=False))
        _network_delivery_worker(tn._dispatch_semaphore, "Late", "Body", "info", None, past_deadline, outcome)

        self.assertFalse(outcome[0])
        mock_urlopen.assert_not_called()

    def test_async_dispatch_does_not_block_under_saturation(self):
        """[Round 6 Finding 4] Verify async notification dispatch returns False immediately under saturation without blocking."""
        import time
        import triad.notifier as tn

        # Exhaust all available semaphore permits
        permits = []
        for _ in range(tn.MAX_CONCURRENT_NOTIFICATIONS):
            permits.append(tn._dispatch_semaphore.acquire(blocking=False))
        self.assertTrue(all(permits))

        # Attempting async notification while saturated must reject immediately (< 0.05s) even with high timeout
        t0 = time.monotonic()
        res = notify_event("Saturated", "Body", async_dispatch=True, timeout=5.0)
        t1 = time.monotonic()
        self.assertFalse(res, "Async dispatch must return False under saturation")
        self.assertLess(t1 - t0, 0.05, "Async dispatch must not block caller thread under saturation")


if __name__ == "__main__":
    unittest.main(verbosity=2)
