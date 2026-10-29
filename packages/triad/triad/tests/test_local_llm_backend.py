#!/usr/bin/env python3
"""
Local advisor backend: llama.cpp (:8080, OpenAI /v1/chat/completions) by default,
EXOCORTEX_TRIAD_BACKEND=ollama restores the legacy `ollama run` subprocess on :11434.
"""

import json
import os
import unittest
from unittest.mock import patch

from triad import advisor_manager as am
from triad import paths


def _advisor():
    adv = am.get_active_advisor("ollama")
    assert adv is not None
    return adv


class FakeResponse:
    def __init__(self, payload):
        self._raw = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestBackendSelection(unittest.TestCase):
    def test_default_is_llamacpp_on_8080(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("EXOCORTEX_TRIAD_BACKEND", None)
            os.environ.pop("LLAMA_CPP_URL", None)
            self.assertEqual(paths.local_backend(), "llamacpp")
            self.assertEqual(paths.local_llm_port(), 8080)
            self.assertEqual(am._resolve_readiness_port(_advisor()), 8080)

    def test_ollama_override_restores_11434(self):
        with patch.dict(os.environ, {"EXOCORTEX_TRIAD_BACKEND": "ollama"}):
            self.assertEqual(paths.local_backend(), "ollama")
            self.assertEqual(paths.local_llm_port(), paths.PORT_OLLAMA)
            eff = am.effective_advisor(_advisor())
            self.assertNotIn("transport", eff)
            self.assertEqual(eff["fallback_binary"], "ollama")
            self.assertEqual(eff["execution_flags"][:2], ["run", "qwen3:1.7b"])
            self.assertEqual(am._resolve_readiness_port(eff), paths.PORT_OLLAMA)

    def test_default_effective_advisor_is_http(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("EXOCORTEX_TRIAD_BACKEND", None)
            self.assertEqual(am.effective_advisor(_advisor())["transport"], "openai_http")

    def test_loopback_only(self):
        self.assertEqual(paths.validate_loopback_url("http://127.0.0.1:8080/"), "http://127.0.0.1:8080")
        self.assertEqual(paths.validate_loopback_url("http://localhost:8080"), "http://localhost:8080")
        for bad in (
            "http://192.168.1.5:8080",
            "https://127.0.0.1:8080",
            "http://example.com:8080",
            "http://user:pw@127.0.0.1:8080",
            "http://127.0.0.1:8080/?x=1",
        ):
            with self.assertRaises(ValueError, msg=bad):
                paths.validate_loopback_url(bad)

    def test_non_loopback_env_url_is_refused_before_any_request(self):
        with patch.dict(os.environ, {"LLAMA_CPP_URL": "http://10.0.0.9:8080"}):
            os.environ.pop("EXOCORTEX_TRIAD_BACKEND", None)
            with patch("urllib.request.OpenerDirector.open") as opener:
                out = am._execute_single_advisor_raw(_advisor(), "hi")
            opener.assert_not_called()
            self.assertIn("loopback", out)


class TestHttpAdvisor(unittest.TestCase):
    def setUp(self):
        self._env = patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop("EXOCORTEX_TRIAD_BACKEND", None)
        os.environ.pop("LLAMA_CPP_URL", None)

    def tearDown(self):
        self._env.stop()

    def test_posts_openai_chat_and_strips_think_blocks(self):
        seen = {}

        def fake_open(self_, req, timeout=None):
            seen["url"] = req.full_url
            seen["body"] = json.loads(req.data.decode("utf-8"))
            seen["timeout"] = timeout
            return FakeResponse({"choices": [{"message": {"content": "<think>hmm</think>sorted."}}]})

        with patch("urllib.request.OpenerDirector.open", fake_open):
            out = am._execute_single_advisor_raw(_advisor(), "sort the imports", timeout=7)
        self.assertEqual(out, "sorted.")
        self.assertEqual(seen["url"], "http://127.0.0.1:8080/v1/chat/completions")
        self.assertEqual(seen["body"]["model"], "qwen3:1.7b")
        self.assertFalse(seen["body"]["stream"])
        self.assertIn("sort the imports", seen["body"]["messages"][0]["content"])
        self.assertEqual(seen["timeout"], 7)

    def test_server_down_returns_error_string(self):
        def boom(self_, req, timeout=None):
            raise ConnectionRefusedError("refused")

        with patch("urllib.request.OpenerDirector.open", boom):
            out = am._execute_single_advisor_raw(_advisor(), "hi")
        self.assertTrue(out.startswith("[Error calling"), out)

    def test_ollama_override_uses_subprocess_not_http(self):
        with patch.dict(os.environ, {"EXOCORTEX_TRIAD_BACKEND": "ollama"}):
            with patch("urllib.request.OpenerDirector.open") as opener, \
                 patch.object(am.subprocess, "Popen", side_effect=FileNotFoundError("no ollama")) as popen:
                out = am._execute_single_advisor_raw(_advisor(), "hi")
        opener.assert_not_called()
        popen.assert_called_once()
        self.assertIn("Error", out)

    def test_readiness_checks_8080_not_11434(self):
        probed = []

        def fake_port(host, port, timeout=0.2):
            probed.append(port)
            return False

        with patch.object(am, "is_port_open", fake_port):
            ready, why = am.advisor_is_ready(_advisor())
        self.assertFalse(ready)
        self.assertEqual(probed, [8080])
        self.assertIn("8080", why)


if __name__ == "__main__":
    unittest.main()
