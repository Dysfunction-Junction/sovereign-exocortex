#!/usr/bin/env python3
"""
Unit tests for Triad Ambient HTTP Server (triad/server.py).
Tests:
- Server startup and graceful shutdown
- GET /health (service, version, subsystems, advisors)
- GET /telemetry (sessions aggregate metrics, pagination)
- POST /auto (intent classification and execution)
- POST /review (diff review endpoints)
- CORS header verification
"""

import json
import time
import socket
import urllib.request
import urllib.error
import threading
import unittest
from unittest.mock import patch, MagicMock
from http.server import ThreadingHTTPServer

from triad.server import TriadRequestHandler


def find_free_port() -> int:
    """Locate an available local ephemeral port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class TestTriadServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = find_free_port()
        cls.server = ThreadingHTTPServer(("127.0.0.1", cls.port), TriadRequestHandler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=2.0)

    def _get(self, path: str, extra_headers: dict = None):
        url = f"{self.base_url}{path}"
        h = {"Connection": "close"}
        if extra_headers:
            h.update(extra_headers)
        req = urllib.request.Request(url, headers=h, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                data = resp.read().decode("utf-8")
                return resp.status, resp.headers, json.loads(data)
        except urllib.error.HTTPError as exc:
            data = exc.read().decode("utf-8")
            try:
                payload = json.loads(data) if data else {}
            except Exception:
                payload = {"raw": data}
            return exc.code, exc.headers, payload

    def _post(self, path: str, payload: dict, extra_headers: dict = None):
        url = f"{self.base_url}{path}"
        body = json.dumps(payload).encode("utf-8")
        h = {"Content-Type": "application/json", "Connection": "close"}
        if extra_headers:
            h.update(extra_headers)
        req = urllib.request.Request(url, data=body, headers=h, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10.0) as resp:
                data = resp.read().decode("utf-8")
                return resp.status, resp.headers, json.loads(data)
        except urllib.error.HTTPError as exc:
            data = exc.read().decode("utf-8")
            try:
                payload = json.loads(data) if data else {}
            except Exception:
                payload = {"raw": data}
            return exc.code, exc.headers, payload

    def test_health_endpoint(self):
        status, headers, body = self._get("/health", extra_headers={"Origin": "http://localhost:3000"})
        self.assertEqual(status, 200)
        self.assertEqual(body.get("status"), "ok")
        self.assertEqual(body.get("service"), "autonomous-triad")
        self.assertIn("subsystems", body)
        self.assertIn("advisors", body)
        self.assertIn("circuits", body)
        # Check CORS
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "http://localhost:3000")

    def test_root_alias_to_health(self):
        status, _, body = self._get("/")
        self.assertEqual(status, 200)
        self.assertEqual(body.get("status"), "ok")

    def test_telemetry_endpoint(self):
        from unittest.mock import patch
        # Unauthenticated request returns 401
        with patch("triad.server.SERVER_TOKEN", ""):
            status, _, body = self._get("/telemetry")
            self.assertEqual(status, 401)
            self.assertIn("error", body)

        # Authenticated request returns 200 and telemetry data
        with patch("triad.server.SERVER_TOKEN", "mock-telemetry-token"):
            status, _, body = self._get("/telemetry", extra_headers={"Authorization": "Bearer mock-telemetry-token"})
            self.assertEqual(status, 200)
            self.assertIn("total_sessions", body)
            self.assertIn("modes", body)
            self.assertIn("sessions", body)
            self.assertIsInstance(body["sessions"], list)

    def test_auto_doctor_intent(self):
        status, _, body = self._post("/auto", {"prompt": "triad doctor system health"})
        self.assertEqual(status, 200)
        self.assertEqual(body.get("status"), "success")
        self.assertEqual(body.get("intent"), "DOCTOR")
        self.assertIn("result", body)
        self.assertIn("advisors", body["result"])

    def test_auto_debug_intent(self):
        from unittest.mock import patch
        with patch("triad.server.query_configured_advisor", return_value="Mock debug fix"):
            status, _, body = self._post("/auto", {
                "prompt": "why is this failing? Traceback: TypeError: undefined is not a function",
                "context": "const x = null; x();"
            })
            self.assertEqual(status, 200)
            self.assertEqual(body.get("status"), "success")
            self.assertEqual(body.get("intent"), "DEBUG")
            self.assertIn("result", body)

    def test_auto_device_intent(self):
        status, _, body = self._post("/auto", {"prompt": "check android phone notification"})
        self.assertEqual(status, 200)
        self.assertEqual(body.get("intent"), "DEVICE")
        self.assertIn("result", body)
        self.assertIn("bridge_online", body["result"])

    def test_auto_memory_intent(self):
        status, _, body = self._post("/auto", {"prompt": "what was done on past workstream?"})
        self.assertEqual(status, 200)
        self.assertEqual(body.get("intent"), "MEMORY")
        self.assertIn("result", body)
        self.assertIn("pieces_os_online", body["result"])

    def test_auto_worktree_is_not_implemented(self):
        url = f"{self.base_url}/auto"
        body = json.dumps({"prompt": "triad doctor system health", "worktree": True}).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        try:
            urllib.request.urlopen(req, timeout=10.0)
            self.fail("worktree request should be rejected")
        except urllib.error.HTTPError as exc:
            payload = json.loads(exc.read().decode("utf-8"))
            exc.close()
            self.assertEqual(exc.code, 501)
            self.assertIn("triad auto --worktree", payload.get("error", ""))

    def test_cors_options_preflight(self):
        url = f"{self.base_url}/auto"
        # 1. Valid localhost origin -> returned in header
        req = urllib.request.Request(url, headers={"Origin": "http://localhost:8080"}, method="OPTIONS")
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            self.assertEqual(resp.status, 204)
            self.assertEqual(resp.headers.get("Access-Control-Allow-Origin"), "http://localhost:8080")
            self.assertIn("POST", resp.headers.get("Access-Control-Allow-Methods", ""))

        # 2. Spoofed attacker prefix -> no CORS header
        req = urllib.request.Request(url, headers={"Origin": "http://localhost.attacker.com"}, method="OPTIONS")
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            self.assertEqual(resp.status, 204)
            self.assertIsNone(resp.headers.get("Access-Control-Allow-Origin"))

        # 3. Null origin -> no CORS header
        req = urllib.request.Request(url, headers={"Origin": "null"}, method="OPTIONS")
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            self.assertEqual(resp.status, 204)
            self.assertIsNone(resp.headers.get("Access-Control-Allow-Origin"))

    def test_content_type_json_required(self):
        url = f"{self.base_url}/auto"
        body = b"plain text prompt"
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "text/plain"}, method="POST")
        try:
            urllib.request.urlopen(req, timeout=5.0)
            self.fail("text/plain POST should be rejected with 415")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 415)
            exc.close()

    def test_health_advisors_sanitized(self):
        status, _, body = self._get("/health")
        self.assertEqual(status, 200)
        advisors = body.get("advisors", [])
        self.assertTrue(len(advisors) > 0)
        for adv in advisors:
            self.assertNotIn("env", adv)
            self.assertNotIn("binary_path", adv)
            self.assertIn("name", adv)
            self.assertIn("priority", adv)

    def test_action_endpoints(self):
        import os
        from unittest.mock import patch

        # 1. When SERVER_TOKEN is unset, action endpoints must fail closed (401)
        with patch("triad.server.SERVER_TOKEN", ""):
            status, _, body = self._post("/action/approve", {"reason": "Unauthed attempt"})
            self.assertEqual(status, 401)
            self.assertIn("error", body)

            status, _, body = self._post("/action/reject", {"reason": "Unauthed attempt"})
            self.assertEqual(status, 401)

        # 2. When SERVER_TOKEN is configured:
        with patch("triad.server.SERVER_TOKEN", "secret-token-123"):
            # Missing token header -> 401
            status, _, body = self._post("/action/approve", {"reason": "No auth header"})
            self.assertEqual(status, 401)

            # Invalid token -> 401
            status, _, body = self._post("/action/approve", {"reason": "Wrong token"}, extra_headers={"Authorization": "Bearer bad-token"})
            self.assertEqual(status, 401)

            # Valid token with invalid repo path -> 400
            auth_headers = {"Authorization": "Bearer secret-token-123"}
            status, _, body = self._post("/action/approve", {"repo_path": "nonexistent_dir_12345"}, extra_headers=auth_headers)
            self.assertEqual(status, 400)
            self.assertIn("not a valid git repository", body.get("error", ""))

            # Valid token with unsafe patch path -> 400
            status, _, body = self._post("/action/approve", {"patch_file": "C:/Windows/System32/cmd.exe"}, extra_headers=auth_headers)
            self.assertEqual(status, 400)
            self.assertIn("Invalid patch_file", body.get("error", ""))

            # Valid token with an unapplyable patch in PATCHES_DIR
            from triad.server import PATCHES_DIR
            import hashlib
            patch_content = b"# empty dummy patch\n"
            dummy_sha = hashlib.sha256(patch_content).hexdigest()
            temp_patch_path = str(PATCHES_DIR / "test_conflict.patch")
            with open(temp_patch_path, "wb") as pf:
                pf.write(patch_content)

            try:
                # Missing patch_sha256 -> 400
                status, _, body = self._post("/action/approve", {"patch_file": temp_patch_path}, extra_headers=auth_headers)
                self.assertEqual(status, 400)
                self.assertIn("patch_sha256 required", body.get("error", ""))

                # Disallowed repo in TRIAD_ALLOWED_REPOS -> 403
                with patch.dict(os.environ, {"TRIAD_ALLOWED_REPOS": "C:/completely/different/repo"}):
                    status, _, body = self._post("/action/approve", {
                        "patch_file": temp_patch_path,
                        "patch_sha256": dummy_sha,
                    }, extra_headers=auth_headers)
                    self.assertEqual(status, 403)
                    self.assertIn("TRIAD_ALLOWED_REPOS", body.get("error", ""))

                status, _, body = self._post("/action/approve", {
                    "patch_file": temp_patch_path,
                    "patch_sha256": dummy_sha,
                    "reason": "Conflict patch"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 409)
                self.assertEqual(body.get("status"), "conflict")
                self.assertIn("does not apply cleanly", body.get("error", ""))

                # Mismatched SHA256 -> 409 Conflict
                status, _, body = self._post("/action/approve", {
                    "patch_file": temp_patch_path,
                    "patch_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
                }, extra_headers=auth_headers)
                self.assertEqual(status, 409)
                self.assertEqual(body.get("status"), "conflict")
                self.assertIn("digest mismatch", body.get("error", ""))
            finally:
                try:
                    import os
                    os.unlink(temp_patch_path)
                except Exception:
                    pass

            # Action approve without patch file (e.g. manual gate approval) -> 200
            status, _, body = self._post("/action/approve", {"reason": "Approved without patch"}, extra_headers=auth_headers)
            self.assertEqual(status, 200)
            self.assertEqual(body.get("status"), "approved")
            self.assertFalse(body.get("patch_applied"))

            # Mixed inputs: proposal_id and patch_file together -> 400
            status, _, body = self._post("/action/approve", {
                "proposal_id": "prop_12345",
                "nonce": "testnonce12345",
                "patch_file": "some_patch.patch"
            }, extra_headers=auth_headers)
            self.assertEqual(status, 400)
            self.assertIn("cannot provide both", body.get("error", ""))

            # Proposal approve missing nonce -> 400
            status, _, body = self._post("/action/approve", {
                "proposal_id": "prop_12345"
            }, extra_headers=auth_headers)
            self.assertEqual(status, 400)
            self.assertIn("nonce", body.get("error", ""))

            # Unreachable upstream -> 502 fail closed (isolated on unused ephemeral port)
            with patch.dict(os.environ, {"REGISTRY_APP_UPSTREAM": "http://127.0.0.1:59999"}):
                status, _, body = self._post("/action/approve", {
                    "proposal_id": "prop_12345",
                    "nonce": "testnonce12345"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 502)
                self.assertFalse(body.get("ok"))
                self.assertEqual(body.get("status"), "release_failed")

            # Upstream HTTPError 403 (invalid nonce) -> 409 mapped release_failed with upstream_status 403
            import io
            err_403 = urllib.error.HTTPError("http://127.0.0.1:39403", 403, "Forbidden", {}, io.BytesIO(b"{}"))
            with patch("triad.server._OPENER.open", side_effect=err_403):
                status, _, body = self._post("/action/approve", {
                    "proposal_id": "prop_12345",
                    "nonce": "bad_nonce"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 409)
                self.assertFalse(body.get("ok"))
                self.assertEqual(body.get("status"), "release_failed")
                self.assertEqual(body.get("upstream_status"), 403)

            # Upstream HTTPError 500 -> 504 release_unknown fail closed
            err_500 = urllib.error.HTTPError("http://127.0.0.1:39403", 500, "Internal Server Error", {}, io.BytesIO(b"{}"))
            with patch("triad.server._OPENER.open", side_effect=err_500):
                status, _, body = self._post("/action/approve", {
                    "proposal_id": "prop_12345",
                    "nonce": "server_err_nonce"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 504)
                self.assertFalse(body.get("ok"))
                self.assertEqual(body.get("status"), "release_unknown")
                self.assertEqual(body.get("upstream_status"), 500)

            # Upstream timeout -> 504 release_unknown
            with patch("triad.server._OPENER.open", side_effect=TimeoutError("timed out")):
                status, _, body = self._post("/action/approve", {
                    "proposal_id": "prop_12345",
                    "nonce": "timeout_nonce"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 504)
                self.assertFalse(body.get("ok"))
                self.assertEqual(body.get("status"), "release_unknown")

            # ConnectionResetError after send -> 504 release_unknown
            with patch("triad.server._OPENER.open", side_effect=ConnectionResetError("connection reset")):
                status, _, body = self._post("/action/approve", {
                    "proposal_id": "prop_12345",
                    "nonce": "reset_nonce"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 504)
                self.assertFalse(body.get("ok"))
                self.assertEqual(body.get("status"), "release_unknown")

            # Malformed ID format (nonce with space) -> 400 without calling opener
            with patch("triad.server._OPENER.open") as mock_opener:
                status, _, body = self._post("/action/approve", {
                    "proposal_id": "prop_12345",
                    "nonce": "bad nonce with space"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 400)
                mock_opener.assert_not_called()

            # Malformed biometric_attestation (non-string, empty, whitespace, lone surrogate, or oversized bytes) -> 400 without calling opener
            for bad_att in [123456, "", "   ", "x" * 4097, "\ud800", "é" * 2049]:
                with patch("triad.server._OPENER.open") as mock_opener:
                    status, _, body = self._post("/action/approve", {
                        "proposal_id": "prop_12345",
                        "nonce": "good_nonce",
                        "biometric_attestation": bad_att
                    }, extra_headers=auth_headers)
                    self.assertEqual(status, 400)
                    mock_opener.assert_not_called()

            # Non-loopback REGISTRY_APP_UPSTREAM -> 502 unreachable
            with patch.dict(os.environ, {"REGISTRY_APP_UPSTREAM": "http://evil-proxy.com:39403"}):
                status, _, body = self._post("/action/approve", {
                    "proposal_id": "prop_12345",
                    "nonce": "good_nonce"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 502)
                self.assertFalse(body.get("ok"))

            # Upstream 200 with ok: false -> 409 release_rejected
            mock_rej_resp = MagicMock()
            mock_rej_resp.read.return_value = json.dumps({"ok": False, "error": "Nonce expired"}).encode("utf-8")
            mock_rej_resp.__enter__.return_value = mock_rej_resp
            with patch("triad.server._OPENER.open", return_value=mock_rej_resp):
                status, _, body = self._post("/action/approve", {
                    "proposal_id": "prop_12345",
                    "nonce": "expired_nonce"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 409)
                self.assertFalse(body.get("ok"))
                self.assertEqual(body.get("status"), "release_rejected")

            # Upstream success 200 -> 200
            mock_ok_resp = MagicMock()
            mock_ok_resp.read.return_value = json.dumps({"ok": True, "result": {"status": "released"}}).encode("utf-8")
            mock_ok_resp.__enter__.return_value = mock_ok_resp
            with patch("triad.server._OPENER.open", return_value=mock_ok_resp):
                status, _, body = self._post("/action/approve", {
                    "proposal_id": "prop_12345",
                    "nonce": "good_nonce",
                    "reason": "Biometric 1-tap confirmation"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 200)
                self.assertTrue(body.get("ok"))
                self.assertEqual(body.get("proposal_id"), "prop_12345")
                self.assertEqual(body.get("status"), "approved")

            # Action reject with valid token -> 200
            status, _, body = self._post("/action/reject", {"reason": "Test rejection"}, extra_headers=auth_headers)
            self.assertEqual(status, 200)
            self.assertEqual(body.get("status"), "rejected")

            # Action reject with proposal_id and mocked 200 upstream -> 200
            mock_purge_resp = MagicMock()
            mock_purge_resp.read.return_value = json.dumps({"ok": True, "result": {"status": "purged"}}).encode("utf-8")
            mock_purge_resp.__enter__.return_value = mock_purge_resp
            with patch("triad.server._OPENER.open", return_value=mock_purge_resp):
                status, _, body = self._post("/action/reject", {
                    "proposal_id": "prop_12345",
                    "reason": "User rejected"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 200)
                self.assertEqual(body.get("status"), "rejected")
                self.assertEqual(body.get("proposal_id"), "prop_12345")
                self.assertTrue(body.get("upstream_notified"))

            # Action reject with upstream failure -> 502 reject_unconfirmed
            with patch("triad.server._OPENER.open", side_effect=ConnectionRefusedError("connection refused")):
                status, _, body = self._post("/action/reject", {
                    "proposal_id": "prop_12345",
                    "reason": "User rejected"
                }, extra_headers=auth_headers)
                self.assertEqual(status, 502)
                self.assertEqual(body.get("status"), "reject_unconfirmed")
                self.assertFalse(body.get("upstream_notified"))


    def test_auto_doctor_sanitizes_advisors(self):
        status, _, body = self._post("/auto", {"prompt": "triad doctor check system health and subscriptions"})
        self.assertEqual(status, 200)
        self.assertEqual(body.get("intent"), "DOCTOR")
        res = body.get("result", {})
        advisors = res.get("advisors", [])
        self.assertTrue(len(advisors) > 0)
        for adv in advisors:
            self.assertNotIn("env", adv)
            self.assertNotIn("binary_path", adv)
            self.assertIn("name", adv)

    def test_loopback_delegate_classifies_without_leaving_the_pc(self):
        status, _headers, body = self._post("/mishmash/delegate", {
            "v": 1,
            "id": "0123456789abcdef",
            "from": "pieces-android-companion-seamless",
            "to": "autonomous-triad",
            "capability": "intent",
            "action": "classify",
            "payload": {"text": "review this diff"},
        })
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["from"], "autonomous-triad")
        self.assertIn("intent", body["result"])

    def test_mishmash_delegate_classify_and_risk_gating(self):
        status, _, body = self._post("/mishmash/delegate", {
            "v": 1,
            "id": "test-env-0001",
            "from": "test-client",
            "to": "autonomous-triad",
            "capability": "intent",
            "action": "ping",
            "payload": {},
        })
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))
        self.assertEqual(body.get("result", {}).get("status"), "ok")

        status, _, body = self._post("/mishmash/delegate", {
            "v": 1,
            "id": "test-env-0002",
            "from": "test-client",
            "to": "autonomous-triad",
            "capability": "intent",
            "action": "classify",
            "payload": {"text": "what did i do on Monday?"},
        })
        self.assertEqual(status, 200)
        res = body.get("result", {})
        self.assertEqual(res.get("intent"), "MEMORY")
        self.assertEqual(res.get("risk_level"), "low")
        self.assertFalse(res.get("approval_required"))
        self.assertFalse(res.get("requires_biometric"))

        status, _, body = self._post("/mishmash/delegate", {
            "v": 1,
            "id": "test-env-0003",
            "from": "test-client",
            "to": "autonomous-triad",
            "capability": "intent",
            "action": "classify",
            "payload": {"text": "run database migration for auth tokens"},
        })
        self.assertEqual(status, 200)
        res = body.get("result", {})
        self.assertTrue(res.get("high_stakes"))
        self.assertEqual(res.get("risk_level"), "high")
        self.assertTrue(res.get("approval_required"))
        self.assertTrue(res.get("requires_biometric"))

        # Test delegate action approve missing args -> 400
        status, _, body = self._post("/mishmash/delegate", {
            "v": 1,
            "id": "test-env-0004",
            "from": "test-client",
            "to": "autonomous-triad",
            "capability": "intent",
            "action": "approve",
            "payload": {"proposal_id": "prop_123"},
        })
        self.assertEqual(status, 400)
        self.assertFalse(body.get("ok"))

        # Test delegate action approve when SERVER_TOKEN configured without auth -> 401
        with patch("triad.server.SERVER_TOKEN", "token-xyz"):
            status, _, body = self._post("/mishmash/delegate", {
                "v": 1,
                "id": "test-env-0004b",
                "from": "test-client",
                "to": "autonomous-triad",
                "capability": "intent",
                "action": "approve",
                "payload": {"proposal_id": "prop_123", "nonce": "nonce_123"},
            })
            self.assertEqual(status, 401)
            self.assertFalse(body.get("ok"))

        # Test delegate action approve with mocked release -> 200
        mock_del_resp = MagicMock()
        mock_del_resp.read.return_value = json.dumps({"ok": True, "result": {"status": "released"}}).encode("utf-8")
        mock_del_resp.__enter__.return_value = mock_del_resp
        with patch("triad.server._OPENER.open", return_value=mock_del_resp):
            status, _, body = self._post("/mishmash/delegate", {
                "v": 1,
                "id": "test-env-0005",
                "from": "test-client",
                "to": "autonomous-triad",
                "capability": "intent",
                "action": "approve",
                "payload": {"proposal_id": "prop_123", "nonce": "nonce_123"},
            })
            self.assertEqual(status, 200)
            self.assertTrue(body.get("ok"))
            self.assertEqual(body.get("proposal_id"), "prop_123")

        # Test delegate action reject when SERVER_TOKEN configured without auth -> 401
        with patch("triad.server.SERVER_TOKEN", "token-xyz"):
            status, _, body = self._post("/mishmash/delegate", {
                "v": 1,
                "id": "test-env-0006a",
                "from": "test-client",
                "to": "autonomous-triad",
                "capability": "intent",
                "action": "reject",
                "payload": {"proposal_id": "prop_123"},
            })
            self.assertEqual(status, 401)
            self.assertFalse(body.get("ok"))

        # Test delegate action reject with mocked upstream -> 200
        mock_del_purge = MagicMock()
        mock_del_purge.read.return_value = json.dumps({"ok": True, "result": {"status": "purged"}}).encode("utf-8")
        mock_del_purge.__enter__.return_value = mock_del_purge
        with patch("triad.server._OPENER.open", return_value=mock_del_purge):
            status, _, body = self._post("/mishmash/delegate", {
                "v": 1,
                "id": "test-env-0006",
                "from": "test-client",
                "to": "autonomous-triad",
                "capability": "intent",
                "action": "reject",
                "payload": {"proposal_id": "prop_123"},
            })
            self.assertEqual(status, 200)
            self.assertTrue(body.get("ok"))
            self.assertEqual(body.get("proposal_id"), "prop_123")
            self.assertTrue(body.get("upstream_notified"))

        # Test delegate action reject with upstream failure -> 502
        with patch("triad.server._OPENER.open", side_effect=ConnectionRefusedError("connection refused")):
            status, _, body = self._post("/mishmash/delegate", {
                "v": 1,
                "id": "test-env-0007",
                "from": "test-client",
                "to": "autonomous-triad",
                "capability": "intent",
                "action": "reject",
                "payload": {"proposal_id": "prop_123"},
            })
            self.assertEqual(status, 502)
            self.assertFalse(body.get("ok"))
            self.assertEqual(body.get("status"), "reject_unconfirmed")
            self.assertFalse(body.get("upstream_notified"))

    def test_evaluate_action_risk_unit(self):
        import types
        from triad.server import _evaluate_action_risk
        from triad.intent_engine import classify_intent

        # 1. Destructive command in GENERAL intent must fail closed to high risk
        cls_general = types.SimpleNamespace(intent="GENERAL", high_stakes=False)
        risk, approval, reasons = _evaluate_action_risk(cls_general, "rm -rf /")
        self.assertEqual(risk, "high")
        self.assertTrue(approval)
        self.assertIn("destructive_instruction", reasons)

        # 2. Windows PowerShell / cmd destructive commands
        risk_ps, app_ps, _ = _evaluate_action_risk(cls_general, "Remove-Item -Recurse -Force C:\\Windows")
        self.assertEqual(risk_ps, "high")
        self.assertTrue(app_ps)

        risk_del, app_del, _ = _evaluate_action_risk(cls_general, "del /s /q *.dat")
        self.assertEqual(risk_del, "high")
        self.assertTrue(app_del)

        # 3. Git clean and force push variations
        risk_clean, app_clean, _ = _evaluate_action_risk(cls_general, "git clean -fd")
        self.assertEqual(risk_clean, "high")
        self.assertTrue(app_clean)

        risk_push, app_push, _ = _evaluate_action_risk(cls_general, "git push origin +main")
        self.assertEqual(risk_push, "high")
        self.assertTrue(app_push)

        # 4. DEVICE intent allowlist: read-only queries are low-risk
        cls_device = types.SimpleNamespace(intent="DEVICE", high_stakes=False)
        risk, approval, _ = _evaluate_action_risk(cls_device, "read battery status and show screen info")
        self.assertEqual(risk, "low")
        self.assertFalse(approval)

        # 5. DEVICE intent active actuation requires approval
        risk, approval, reasons = _evaluate_action_risk(cls_device, "tap screen to open settings")
        self.assertEqual(risk, "medium")
        self.assertTrue(approval)
        self.assertIn("device_actuation", reasons)

        # 6. Instruction vs material: REVIEW of a diff that has 'delete' stays low-risk read-only
        cls_review = types.SimpleNamespace(intent="REVIEW", high_stakes=False)
        risk, approval, _ = _evaluate_action_risk(cls_review, text="review this pull request", diff="--- a/file\n+++ b/file\n-delete_old_records()")
        self.assertEqual(risk, "low")
        self.assertFalse(approval)

        # 7. But if review prompt instruction itself asks to delete, it triggers high
        risk_del_inst, app_del_inst, _ = _evaluate_action_risk(cls_review, text="delete the repository after review")
        self.assertEqual(risk_del_inst, "high")
        self.assertTrue(app_del_inst)

        # 8. Real classifier return type compatibility
        real_cls = classify_intent("what did i do on Monday?")
        risk, approval, _ = _evaluate_action_risk(real_cls, "what did i do on Monday?")
        self.assertEqual(risk, "low")
        self.assertFalse(approval)

        # 9. high_stakes=True overrides every intent
        cls_high = types.SimpleNamespace(intent="MEMORY", high_stakes=True)
        risk, approval, reasons = _evaluate_action_risk(cls_high, "recall past work")
        self.assertEqual(risk, "high")
        self.assertTrue(approval)
        self.assertIn("high_stakes_domain", reasons)

        # 10. Oversized input fails closed with oversized_input flag
        risk_ov, app_ov, reasons_ov = _evaluate_action_risk(cls_general, "a" * 300_000)
        self.assertEqual(risk_ov, "high")
        self.assertTrue(app_ov)
        self.assertIn("oversized_input", reasons_ov)

        # 11. Pathological input timing test (linear token scan completes well within bound)
        import time
        start_t = time.perf_counter()
        _evaluate_action_risk(cls_general, "git clean " * 20_000)
        elapsed_ms = (time.perf_counter() - start_t) * 1000
        self.assertLess(elapsed_ms, 2500)

        # 12. DEVICE mixed-verb cases (read-only cannot bypass active actuation)
        risk_mix, app_mix, _ = _evaluate_action_risk(cls_device, "factory reset the phone and check status")
        self.assertEqual(risk_mix, "medium")
        self.assertTrue(app_mix)

        # 13. rm flag order variations
        risk_rm1, app_rm1, _ = _evaluate_action_risk(cls_general, "rm /tmp/x -rf")
        self.assertEqual(risk_rm1, "high")
        self.assertTrue(app_rm1)

        risk_rm2, app_rm2, _ = _evaluate_action_risk(cls_general, "rm --recursive --force /var/data")
        self.assertEqual(risk_rm2, "high")
        self.assertTrue(app_rm2)

        # 14. Git remote ref deletion (e.g. :main)
        risk_del_ref, app_del_ref, _ = _evaluate_action_risk(cls_general, "git push origin :main")
        self.assertEqual(risk_del_ref, "high")
        self.assertTrue(app_del_ref)

        # 15. Git global options with value (-C repo)
        risk_git_c, app_git_c, _ = _evaluate_action_risk(cls_general, "git -C /path/to/repo reset --hard")
        self.assertEqual(risk_git_c, "high")
        self.assertTrue(app_git_c)

        # 16. Markdown backtick wrapped commands
        risk_bt, app_bt, _ = _evaluate_action_risk(cls_general, "run `git reset --hard` now")
        self.assertEqual(risk_bt, "high")
        self.assertTrue(app_bt)

        # 17. Windows PowerShell Remove-Item with -r / -Recurse
        risk_pw, app_pw, _ = _evaluate_action_risk(cls_general, "Remove-Item -r C:\\sandbox")
        self.assertEqual(risk_pw, "high")
        self.assertTrue(app_pw)

        # 18. git restore worktree vs staged: only pure staged unstage is non-destructive
        risk_rest_w, app_rest_w, _ = _evaluate_action_risk(cls_general, "git restore --staged --worktree .")
        self.assertEqual(risk_rest_w, "high")
        self.assertTrue(app_rest_w)

        risk_rest_p, app_rest_p, _ = _evaluate_action_risk(cls_general, "git restore file.txt")
        self.assertEqual(risk_rest_p, "high")
        self.assertTrue(app_rest_p)

        risk_rest_s, app_rest_s, _ = _evaluate_action_risk(cls_general, "git restore --staged file.txt")
        self.assertEqual(risk_rest_s, "low")
        self.assertFalse(app_rest_s)

        # 19. git checkout HEAD <file> vs git checkout <branch>
        risk_co_head, app_co_head, _ = _evaluate_action_risk(cls_general, "git checkout HEAD file.txt")
        self.assertEqual(risk_co_head, "high")
        self.assertTrue(app_co_head)

        risk_co_dash, app_co_dash, _ = _evaluate_action_risk(cls_general, "git checkout -- file.txt")
        self.assertEqual(risk_co_dash, "high")
        self.assertTrue(app_co_dash)

        risk_co_br, app_co_br, _ = _evaluate_action_risk(cls_general, "git checkout main")
        self.assertEqual(risk_co_br, "low")
        self.assertFalse(app_co_br)

        risk_co_nb, app_co_nb, _ = _evaluate_action_risk(cls_general, "git checkout -b feature/cool")
        self.assertEqual(risk_co_nb, "low")
        self.assertFalse(app_co_nb)

        # 20. Device actuation matches underscores and digits
        risk_tap, app_tap, r_tap = _evaluate_action_risk(cls_device, "check tap_screen")
        self.assertEqual(risk_tap, "medium")
        self.assertTrue(app_tap)
        self.assertIn("device_actuation", r_tap)

        risk_swp, app_swp, r_swp = _evaluate_action_risk(cls_device, "inspect swipe_up")
        self.assertEqual(risk_swp, "medium")
        self.assertTrue(app_swp)
        self.assertIn("device_actuation", r_swp)

        # 21. Missing high_stakes attribute fails closed
        cls_missing = types.SimpleNamespace(intent="GENERAL")
        risk_m, app_m, reasons_m = _evaluate_action_risk(cls_missing, "echo safe")
        self.assertEqual(risk_m, "high")
        self.assertTrue(app_m)
        self.assertTrue(any("risk_eval_error" in r for r in reasons_m))

        # 22. REVIEW/GATE context scanning vs diff material isolation
        cls_rev = types.SimpleNamespace(intent="REVIEW", high_stakes=False)
        risk_ctx, app_ctx, _ = _evaluate_action_risk(cls_rev, text="review this pull request", context="then run rm -rf /")
        self.assertEqual(risk_ctx, "high")
        self.assertTrue(app_ctx)

        risk_diff, app_diff, _ = _evaluate_action_risk(cls_rev, text="review this pull request", diff="--- a/f\n+++ b/f\n-rm -rf /")
        self.assertEqual(risk_diff, "low")
        self.assertFalse(app_diff)

        # 23. Quadratic shell input regression: bounded slice ensures linear O(N) scaling
        t_rm = time.perf_counter()
        _evaluate_action_risk(cls_general, "rm " * 80_000)
        elapsed_rm = (time.perf_counter() - t_rm) * 1000
        self.assertLess(elapsed_rm, 2500)

        t_del = time.perf_counter()
        _evaluate_action_risk(cls_general, "del " * 60_000)
        elapsed_del = (time.perf_counter() - t_del) * 1000
        self.assertLess(elapsed_del, 2500)

        # 24. git push -d short flag for remote deletion
        risk_push_d, app_push_d, _ = _evaluate_action_risk(cls_general, "git push -d origin old-feature")
        self.assertEqual(risk_push_d, "high")
        self.assertTrue(app_push_d)

        # 25. git switch -f and --discard-changes
        risk_sw_f, app_sw_f, _ = _evaluate_action_risk(cls_general, "git switch -f experiment")
        self.assertEqual(risk_sw_f, "high")
        self.assertTrue(app_sw_f)

        risk_sw_d, app_sw_d, _ = _evaluate_action_risk(cls_general, "git switch --discard-changes main")
        self.assertEqual(risk_sw_d, "high")
        self.assertTrue(app_sw_d)

        # 26. git checkout --ours / --theirs
        risk_co_ours, app_co_ours, _ = _evaluate_action_risk(cls_general, "git checkout --ours conflicted.txt")
        self.assertEqual(risk_co_ours, "high")
        self.assertTrue(app_co_ours)

        # 27. Line continuation bypass resistance (git reset \\\n--hard)
        risk_cont, app_cont, _ = _evaluate_action_risk(cls_general, "git reset \\\n--hard")
        self.assertEqual(risk_cont, "high")
        self.assertTrue(app_cont)

        # 28. Unicode dash normalization (en-dash \u2013 in rm –rf /)
        risk_dash, app_dash, _ = _evaluate_action_risk(cls_general, "rm \u2013rf /")
        self.assertEqual(risk_dash, "high")
        self.assertTrue(app_dash)

        # 29. REVIEW intent detects destructive added lines (+) in diff
        risk_diff_add, app_diff_add, reasons_add = _evaluate_action_risk(
            cls_rev, text="review this PR", diff="--- a/script.sh\n+++ b/script.sh\n+rm -rf /"
        )
        self.assertEqual(risk_diff_add, "high")
        self.assertTrue(app_diff_add)
        self.assertIn("destructive_payload", reasons_add)


class TestResolveRepoPathContainment(unittest.TestCase):
    def test_allowlist_enforced_inside_resolver(self):
        import os
        import subprocess
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        from triad.server import RepoNotAllowed, _resolve_repo_path

        with tempfile.TemporaryDirectory() as td:
            allowed = Path(td) / "repo"
            sibling = Path(td) / "repo_evil"
            for d in (allowed, sibling):
                d.mkdir()
                subprocess.run(["git", "init", "-q", str(d)], check=True)
            with patch.dict(os.environ, {"TRIAD_ALLOWED_REPOS": str(allowed)}):
                self.assertEqual(_resolve_repo_path(str(allowed)).resolve(), allowed.resolve())
                with self.assertRaises(RepoNotAllowed):
                    _resolve_repo_path(str(sibling))  # shares a name prefix, must not pass
                with self.assertRaises(RepoNotAllowed):
                    _resolve_repo_path(str(allowed / ".." / "repo_evil"))
                self.assertIsNone(_resolve_repo_path(str(allowed / "missing_dir")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
