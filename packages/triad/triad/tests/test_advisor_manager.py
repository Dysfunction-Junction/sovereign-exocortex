#!/usr/bin/env python3
"""
Unit tests for Triad Advisor Manager (triad/advisor_manager.py).
Verifies:
- Loading of declarative advisors.json configuration
- Runtime inspection (get_advisors, get_active_advisor)
- Execution of configured advisors (mock, claude)
- Dynamic registration of third advisors via configuration edits without modifying code
- Auto-failover logic across configured advisor priorities
"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from triad.advisor_manager import (
    get_advisors,
    get_active_advisor,
    query_configured_advisor,
    add_advisor,
    save_config,
    expand_env_value,
)


class TestAdvisorManager(unittest.TestCase):
    def setUp(self):
        # Keep live advisor probes from writing into the user's real circuit file.
        self._circuit_tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self._circuit_tmp.close()
        self._circuit_env = patch.dict(os.environ, {
            "TRIAD_CIRCUIT_PATH": self._circuit_tmp.name,
            "TRIAD_CIRCUIT": "1",
        })
        self._circuit_env.start()

    def tearDown(self):
        self._circuit_env.stop()
        try:
            os.unlink(self._circuit_tmp.name)
        except OSError:
            pass

    def test_expand_env_value_leaves_tokens_alone(self):
        self.assertEqual(expand_env_value("API_KEY", "sk-$HOME-%USERPROFILE%"), "sk-$HOME-%USERPROFILE%")
        self.assertEqual(expand_env_value("PYTHONIOENCODING", "utf-8"), "utf-8")
        self.assertEqual(expand_env_value("SERVICE_URL", "https://api.anthropic.com/v1"), "https://api.anthropic.com/v1")

    def test_expand_env_value_expands_path_keys(self):
        expanded = expand_env_value("TRIAD_CLAUDE_PATH", "{home}/.local/bin/claude.exe")
        self.assertNotIn("{home}", expanded)
        self.assertTrue(expanded.endswith(".local\\bin\\claude.exe") or expanded.endswith(".local/bin/claude.exe"))

        path_expanded = expand_env_value("PATH", "{home}/bin")
        self.assertNotIn("{home}", path_expanded)

        models_expanded = expand_env_value("OLLAMA_MODELS", "{home}/.ollama/models")
        self.assertNotIn("{home}", models_expanded)

    def test_get_advisors_loading_and_sorting(self):
        """Verify advisors are loaded from advisors.json in priority order."""
        advisors = get_advisors()
        self.assertGreaterEqual(len(advisors), 3)

        names = [a.get("name") for a in advisors]
        self.assertIn("claude", names)
        self.assertIn("codex", names)
        self.assertIn("mock", names)

        # Check sorting by priority
        priorities = [a.get("priority", 999) for a in advisors]
        self.assertEqual(priorities, sorted(priorities))

    def test_get_active_advisor(self):
        """Verify lookup by name and default active resolution."""
        claude = get_active_advisor("claude")
        self.assertIsNotNone(claude)
        self.assertEqual(claude.get("name"), "claude")

        mock = get_active_advisor("MOCK")  # Case-insensitive
        self.assertIsNotNone(mock)
        self.assertEqual(mock.get("name"), "mock")

        # Non-existent advisor
        unknown = get_active_advisor("non_existent_engine_xyz")
        self.assertIsNone(unknown)

        # Auto resolution
        auto_adv = get_active_advisor("auto")
        self.assertIsNotNone(auto_adv)
        self.assertEqual(auto_adv.get("name"), "claude")

    def test_query_configured_advisor_mock(self):
        """Verify querying mock advisor via query_configured_advisor."""
        prompt = "Hello from automated triad test"
        resp = query_configured_advisor("mock", prompt)
        self.assertIn("[Mock Advisor]", resp)
        self.assertIn("characters", resp)

    @unittest.skipUnless(
        shutil.which("claude"),
        "requires a local, authenticated Claude Code CLI on PATH -- not available in CI",
    )
    def test_query_configured_advisor_claude(self):
        """Verify live querying of Claude Code advisor."""
        resp = query_configured_advisor("claude", "Respond with OK", timeout=30)
        self.assertTrue(
            "OK" in resp or "session limit" in resp.lower() or "rate limit" in resp.lower(),
            f"Unexpected response from Claude Code: {resp}"
        )

    def test_dynamic_advisor_addition_without_code_change(self):
        """
        Verify that adding a new advisor dynamically via configuration edit
        enables immediate querying without any changes to the engine codebase.
        """
        with tempfile.NamedTemporaryFile(mode="w+", suffix=".json", delete=False, encoding="utf-8") as tf:
            temp_config_path = Path(tf.name)

        try:
            # Create a isolated config with mock and a new dynamic advisor
            dynamic_advisor = {
                "name": "custom_agent_v3",
                "display_name": "Dynamic Custom Agent V3",
                "binary_path": "python",
                "priority": 1,
                "execution_flags": [
                    "-c",
                    "import sys; sys.stdout.write('DYNAMIC_ADVISOR_RESPONSE_SUCCESS')"
                ],
                "input_mode": "stdin",
                "output_mode": "stdout",
                "enabled": True
            }

            initial_data = {
                "advisors": [
                    {
                        "name": "base_mock",
                        "display_name": "Base Mock",
                        "binary_path": "python",
                        "priority": 10,
                        "execution_flags": ["-c", "print('base')"],
                        "enabled": True
                    }
                ]
            }
            save_config(initial_data, temp_config_path)

            # Query before adding: should fail
            res_before = query_configured_advisor("custom_agent_v3", "test", config_path=temp_config_path)
            self.assertIn("not found in configuration", res_before)

            # Dynamically register the new advisor via config edit
            add_advisor(dynamic_advisor, config_path=temp_config_path)

            # Verify it's now in get_advisors()
            advisors = get_advisors(config_path=temp_config_path)
            self.assertEqual(len(advisors), 2)
            self.assertEqual(advisors[0]["name"], "custom_agent_v3")

            # Query the dynamically added advisor: must work without modifying engine code!
            res_after = query_configured_advisor("custom_agent_v3", "test", config_path=temp_config_path)
            self.assertEqual(res_after.strip(), "DYNAMIC_ADVISOR_RESPONSE_SUCCESS")

        finally:
            if temp_config_path.exists():
                try:
                    temp_config_path.unlink()
                except Exception:
                    pass

    def test_auto_failover_across_configured_advisors(self):
        """Verify automatic failover when the primary advisor encounters an error."""
        with tempfile.NamedTemporaryFile(mode="w+", suffix=".json", delete=False, encoding="utf-8") as tf:
            temp_config_path = Path(tf.name)

        try:
            config_data = {
                "advisors": [
                    {
                        "name": "failing_primary",
                        "display_name": "Failing Primary",
                        "binary_path": "python",
                        "priority": 1,
                        "execution_flags": ["-c", "import sys; sys.stderr.write('Rate limit exceeded'); sys.exit(1)"],
                        "enabled": True
                    },
                    {
                        "name": "backup_secondary",
                        "display_name": "Backup Secondary",
                        "binary_path": "python",
                        "priority": 2,
                        "execution_flags": ["-c", "import sys; sys.stdout.write('BACKUP_REACHED')"],
                        "enabled": True
                    }
                ]
            }
            save_config(config_data, temp_config_path)

            resp = query_configured_advisor("auto", "Failover test prompt", config_path=temp_config_path)
            self.assertIn("Advisor Auto-Failover", resp)
            self.assertIn("Backup Secondary", resp)
            self.assertIn("BACKUP_REACHED", resp)

        finally:
            if temp_config_path.exists():
                try:
                    temp_config_path.unlink()
                except Exception:
                    pass


    def test_resolve_binary_precedence(self):
        from triad.advisor_manager import resolve_binary
        import tempfile

        with tempfile.NamedTemporaryFile("w", suffix=".exe", delete=False) as f_cfg:
            f_cfg.write("")
            cfg_path = f_cfg.name
        with tempfile.NamedTemporaryFile("w", suffix=".exe", delete=False) as f_env:
            f_env.write("")
            env_path = f_env.name

        try:
            # 1. Configured binary takes precedence over canonical binary
            resolved = resolve_binary(binary_path=cfg_path, advisor_name="claude")
            self.assertEqual(resolved, cfg_path)

            # 2. Environment override takes precedence over configured binary
            with patch.dict(os.environ, {"TRIAD_CLAUDE_PATH": env_path}):
                resolved_env = resolve_binary(binary_path=cfg_path, advisor_name="claude")
                self.assertEqual(resolved_env, env_path)
        finally:
            for p in (cfg_path, env_path):
                try:
                    os.unlink(p)
                except OSError:
                    pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
