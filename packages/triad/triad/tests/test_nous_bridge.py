#!/usr/bin/env python3
"""
Unit tests for Nous Research Bridge (triad/nous_bridge.py).
"""

import unittest
from unittest.mock import patch, MagicMock
import json
import io
import os
import urllib.error
from triad.nous_bridge import get_nous_token, query_nous


class TestNousBridge(unittest.TestCase):
    def setUp(self):
        # NOUS_MODEL leaking from the ambient environment silently grows
        # models_to_try beyond the cascade length, breaking any test whose
        # side_effect list assumes a fixed number of urlopen calls.
        self._env_patch = patch.dict(os.environ)
        self._env_patch.start()
        os.environ.pop("NOUS_MODEL", None)
        self.addCleanup(self._env_patch.stop)

    def test_get_nous_token_from_env(self):
        with patch.dict("os.environ", {"NOUS_API_KEY": "test_env_key"}):
            self.assertEqual(get_nous_token(), "test_env_key")

    def test_get_nous_token_skips_whitespace_agent_key(self):
        # A whitespace-only agent_key must not shadow a valid access_token --
        # "truthy but useless" values need to be validated, not just checked.
        import triad.nous_bridge as nb
        from unittest.mock import mock_open

        fake_auth = json.dumps({
            "providers": {"nous": {"agent_key": "   ", "access_token": "real_token"}}
        })
        fake_path = MagicMock()
        fake_path.exists.return_value = True
        with patch.dict("os.environ", {}, clear=True), \
             patch.object(nb, "AUTH_FILE", fake_path), \
             patch("builtins.open", mock_open(read_data=fake_auth)):
            self.assertEqual(nb.get_nous_token(), "real_token")

    @patch("triad.nous_bridge.urllib.request.urlopen")
    @patch("triad.nous_bridge.get_nous_token", return_value="dummy_token")
    def test_query_nous_success(self, mock_get_token, mock_urlopen):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({
            "choices": [{"message": {"content": "Verified response from Nous"}}]
        }).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        success, content, model, all_rate_limited = query_nous("test prompt")
        self.assertTrue(success)
        self.assertEqual(content, "Verified response from Nous")
        self.assertFalse(all_rate_limited)

    @patch("triad.nous_bridge.urllib.request.urlopen")
    @patch("triad.nous_bridge.get_nous_token", return_value="dummy_token")
    def test_query_nous_rejects_truncated_response(self, mock_get_token, mock_urlopen):
        # finish_reason == "length" means the model ran out of tokens mid-
        # answer -- must not be reported as success even though content is
        # non-empty, since it may be incomplete or cut off mid-fix.
        truncated = MagicMock()
        truncated.read.return_value = json.dumps({
            "choices": [{"message": {"content": "partial answer that got cut o"}, "finish_reason": "length"}]
        }).encode("utf-8")
        truncated.__enter__.return_value = truncated

        complete = MagicMock()
        complete.read.return_value = json.dumps({
            "choices": [{"message": {"content": "full answer"}, "finish_reason": "stop"}]
        }).encode("utf-8")
        complete.__enter__.return_value = complete

        mock_urlopen.side_effect = [truncated, complete]

        success, content, model, all_rate_limited = query_nous("def calculate(): pass")
        self.assertTrue(success)
        self.assertEqual(content, "full answer")
        self.assertEqual(mock_urlopen.call_count, 2)

    @patch("triad.nous_bridge.urllib.request.urlopen")
    @patch("triad.nous_bridge.get_nous_token", return_value="dummy_token")
    def test_query_nous_failover_on_429(self, mock_get_token, mock_urlopen):
        # First candidate model fails with 429, cascade falls through to the next
        err_429 = urllib.error.HTTPError(
            url="https://inference-api.nousresearch.com/v1/chat/completions",
            code=429,
            msg="Rate limit",
            hdrs={},
            fp=io.BytesIO(b"Rate limit exceeded")
        )
        mock_resp_success = MagicMock()
        mock_resp_success.read.return_value = json.dumps({
            "choices": [{"message": {"content": "Fallback model response"}}]
        }).encode("utf-8")
        mock_resp_success.__enter__.return_value = mock_resp_success

        mock_urlopen.side_effect = [err_429, mock_resp_success]

        success, content, model, all_rate_limited = query_nous("def calculate(): pass")
        self.assertTrue(success)
        self.assertEqual(content, "Fallback model response")
        self.assertEqual(mock_urlopen.call_count, 2)
        self.assertFalse(all_rate_limited)

    @patch("triad.nous_bridge.urllib.request.urlopen")
    @patch("triad.nous_bridge.get_nous_token", return_value="dummy_token")
    def test_query_nous_all_models_rate_limited(self, mock_get_token, mock_urlopen):
        # Every model in the cascade 429s -> exhaustion should be reported as
        # a pure rate-limit condition (all_rate_limited=True), and main()
        # routes that to stdout so advisor_manager.py's existing classifier
        # (unmodified by this change) recognizes it.
        def make_429():
            return urllib.error.HTTPError(
                url="https://inference-api.nousresearch.com/v1/chat/completions",
                code=429,
                msg="Rate limit",
                hdrs={},
                fp=io.BytesIO(b"Rate limit exceeded"),
            )

        mock_urlopen.side_effect = [make_429(), make_429(), make_429(), make_429()]

        success, content, model, all_rate_limited = query_nous("def calculate(): pass")
        self.assertFalse(success)
        self.assertTrue(all_rate_limited)
        self.assertIn("rate limit", content.lower())

    @patch("triad.nous_bridge.urllib.request.urlopen")
    @patch("triad.nous_bridge.get_nous_token", return_value="dummy_token")
    def test_query_nous_mixed_429_then_500_not_reported_as_rate_limit(self, mock_get_token, mock_urlopen):
        # A 429 followed by a non-429 failure across the cascade must NOT be
        # classified as a pure rate limit -- the last failure had nothing to
        # do with rate limiting.
        err_429 = urllib.error.HTTPError(
            url="https://inference-api.nousresearch.com/v1/chat/completions",
            code=429,
            msg="Rate limit",
            hdrs={},
            fp=io.BytesIO(b"Rate limit exceeded"),
        )
        err_500 = urllib.error.HTTPError(
            url="https://inference-api.nousresearch.com/v1/chat/completions",
            code=500,
            msg="Internal Server Error",
            hdrs={},
            fp=io.BytesIO(b"Internal Server Error"),
        )
        mock_urlopen.side_effect = [err_429, err_500, err_500, err_500]

        success, content, model, all_rate_limited = query_nous("def calculate(): pass")
        self.assertFalse(success)
        self.assertFalse(all_rate_limited)
        self.assertIn("error", content.lower())

    def test_detect_task_category_routing(self):
        from triad.nous_bridge import detect_task_category
        self.assertEqual(detect_task_category("def solve(x): return x * 2"), "coding")
        self.assertEqual(detect_task_category("diff --git a/file.py b/file.py"), "coding")
        self.assertEqual(detect_task_category("Traceback (most recent call last):"), "coding")
        self.assertEqual(detect_task_category("Evaluate system architecture and database schema"), "architecture")
        self.assertEqual(detect_task_category("Tap the notification button on Android screen"), "mobile")
        self.assertEqual(detect_task_category("What is the capital of France?"), "general")

    @patch("triad.nous_bridge.urllib.request.urlopen")
    @patch("triad.nous_bridge.get_nous_token", return_value="dummy_token")
    def test_task_specific_model_selection(self, mock_get_token, mock_urlopen):
        # Verify coding task routes to poolside model first.
        # (NOUS_MODEL is cleared for every test by setUp.)
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({
            "choices": [{"message": {"content": "code analysis"}}]
        }).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        success, content, model, all_rate_limited = query_nous("def calculate(): pass")
        self.assertTrue(success)
        self.assertEqual(model, "poolside/laguna-xs-2.1:free")
        self.assertFalse(all_rate_limited)


if __name__ == "__main__":
    unittest.main()
