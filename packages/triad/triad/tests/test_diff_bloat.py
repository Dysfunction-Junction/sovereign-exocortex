#!/usr/bin/env python3
"""Unit tests for diff bloat stripping, marker anchoring, idempotency, and code/doc classification."""

from pathlib import Path
import os
import subprocess
import sys
import tempfile
import time
import unittest

from triad.procutil import (
    strip_diff_bloat,
    is_doc_or_asset_file,
    clean_git_env,
    LOCKFILE_NAMES,
    MINIFIED_EXTENSIONS,
    BINARY_ASSET_EXTENSIONS,
    DOC_EXTENSIONS,
    ASSET_EXTENSIONS,
)
from triad.triad_engine import (
    _affects_typescript,
    _affects_code,
    _resolve_targeted_test_pattern,
    _build_python_isolation_script,
    _build_python_multi_pattern_script,
    _resolve_pytest_xdist_cmd,
    _has_importers,
    _import_index,
    _clear_import_index_caches,
    _FILE_IMPORT_CACHE,
    _normalize_target,
    _check_apply_verified_safety,
    build_parser,
)


class TestDiffBloatStripper(unittest.TestCase):
    def test_constants_defined(self):
        self.assertIn("uv.lock", LOCKFILE_NAMES)
        self.assertIn("bun.lockb", LOCKFILE_NAMES)
        self.assertIn("go.sum", LOCKFILE_NAMES)
        self.assertIn(".min.js", MINIFIED_EXTENSIONS)
        self.assertIn(".png", BINARY_ASSET_EXTENSIONS)
        self.assertIn(".md", DOC_EXTENSIONS)
        self.assertIn(".pdf", ASSET_EXTENSIONS)

    def test_clean_git_env_exported_and_functional(self):
        env = clean_git_env({"FOO": "BAR"})
        self.assertIsInstance(env, dict)
        self.assertEqual(env.get("FOO"), "BAR")

    def test_empty_or_none_diff(self):
        self.assertEqual(strip_diff_bloat(""), "")
        self.assertEqual(strip_diff_bloat(None), "")
        self.assertEqual(strip_diff_bloat("   \n\t  "), "")

    def test_preserves_normal_code_diff(self):
        normal_diff = (
            "diff --git a/triad/procutil.py b/triad/procutil.py\n"
            "index 1234567..89abcdef 100644\n"
            "--- a/triad/procutil.py\n"
            "+++ b/triad/procutil.py\n"
            "@@ -10,3 +10,4 @@\n"
            " def existing():\n"
            "+def new_function():\n"
            "+    return 42\n"
        )
        result = strip_diff_bloat(normal_diff)
        self.assertIn("def new_function():", result)
        self.assertIn("def existing():", result)
        self.assertNotIn("[Diff omitted", result)

    def test_strips_lockfile_diff(self):
        lockfile_diff = (
            "diff --git a/uv.lock b/uv.lock\n"
            "index 1111111..2222222 100644\n"
            "--- a/uv.lock\n"
            "+++ b/uv.lock\n"
            "@@ -50,6 +50,7 @@\n"
            "+[[package]]\n"
            '+name = "pytest-xdist"\n'
            '+version = "3.8.0"\n'
            '+dependencies = [\n'
            '+    { name = "execnet" },\n'
            "+]\n"
        )
        result = strip_diff_bloat(lockfile_diff)
        self.assertIn("diff --git a/uv.lock b/uv.lock", result)
        self.assertIn("+++ b/uv.lock", result)
        self.assertIn("[Diff omitted: lockfile update (7 lines omitted to preserve LLM context)]", result)
        self.assertNotIn('name = "pytest-xdist"', result)

    def test_strips_minified_file_diff(self):
        min_diff = (
            "diff --git a/dist/bundle.min.js b/dist/bundle.min.js\n"
            "index aaaaaaa..bbbbbbb 100644\n"
            "--- a/dist/bundle.min.js\n"
            "+++ b/dist/bundle.min.js\n"
            "@@ -1,1 +1,1 @@\n"
            "-var a=1;\n"
            "+var a=2;\n"
        )
        result = strip_diff_bloat(min_diff)
        self.assertIn("diff --git a/dist/bundle.min.js b/dist/bundle.min.js", result)
        self.assertIn("[Diff omitted: minified / generated asset (3 lines omitted to preserve LLM context)]", result)
        self.assertNotIn("var a=2;", result)

    def test_strips_binary_diff(self):
        bin_diff = (
            "diff --git a/assets/logo.png b/assets/logo.png\n"
            "index 0000000..1111111 100644\n"
            "Binary files a/assets/logo.png and b/assets/logo.png differ\n"
            "diff-raw-bytes-here\n"
        )
        result = strip_diff_bloat(bin_diff)
        self.assertIn("diff --git a/assets/logo.png b/assets/logo.png", result)
        self.assertIn("[Diff omitted: binary / asset file", result)

    def test_code_mentioning_binary_or_markers_is_not_treated_as_binary(self):
        code_diff = (
            "diff --git a/src/checker.py b/src/checker.py\n"
            "index 1111111..2222222 100644\n"
            "--- a/src/checker.py\n"
            "+++ b/src/checker.py\n"
            "@@ -1,2 +1,4 @@\n"
            " def check():\n"
            '+    pattern = "Binary files a/foo and b/foo differ"\n'
            '+    comment = "[Diff omitted: lockfile update]"\n'
            '+    truncated = "[... 10 lines truncated to protect LLM context ...]"\n'
        )
        result = strip_diff_bloat(code_diff)
        self.assertIn('pattern = "Binary files', result)
        self.assertIn('comment = "[Diff omitted', result)
        self.assertNotIn("lines omitted to preserve LLM context", result)

    def test_paths_with_spaces_and_quotes(self):
        diff_with_spaces = (
            'diff --git "a/path with space/file.min.js" "b/path with space/file.min.js"\n'
            'index 111..222 100644\n'
            '--- "a/path with space/file.min.js"\n'
            '+++ "b/path with space/file.min.js"\n'
            "@@ -1 +1 @@\n"
            "-foo\n"
            "+bar\n"
        )
        result = strip_diff_bloat(diff_with_spaces)
        self.assertIn("[Diff omitted: minified / generated asset", result)

    def test_truncates_huge_file_diff_and_keeps_specified_limit(self):
        large_hunk = "\n".join(f"+line_{i} = {i}" for i in range(120))
        huge_diff = (
            "diff --git a/src/big.py b/src/big.py\n"
            "index 111..222 100644\n"
            "--- a/src/big.py\n"
            "+++ b/src/big.py\n"
            "@@ -1,1 +1,120 @@\n"
            f"{large_hunk}\n"
        )
        result = strip_diff_bloat(huge_diff, max_lines_per_file=50)
        self.assertIn("+line_0 = 0", result)
        self.assertIn("+line_48 = 48", result)
        self.assertNotIn("+line_49 = 49", result)
        self.assertIn("[... 71 lines truncated to protect LLM context ...]", result)

    def test_multi_chunk_strict_idempotency(self):
        multi_diff = (
            "diff --git a/uv.lock b/uv.lock\n"
            "index 1111111..2222222 100644\n"
            "--- a/uv.lock\n"
            "+++ b/uv.lock\n"
            "@@ -50,6 +50,7 @@\n"
            "+[[package]]\n"
            '+name = "pytest-xdist"\n'
            "diff --git a/src/app.py b/src/app.py\n"
            "index 3333333..4444444 100644\n"
            "--- a/src/app.py\n"
            "+++ b/src/app.py\n"
            "@@ -1,2 +1,3 @@\n"
            "+print('hello')\n"
            "diff --git a/assets/icon.png b/assets/icon.png\n"
            "Binary files a/assets/icon.png and b/assets/icon.png differ\n"
        )
        once = strip_diff_bloat(multi_diff)
        twice = strip_diff_bloat(once)
        thrice = strip_diff_bloat(twice)
        self.assertEqual(once, twice)
        self.assertEqual(twice, thrice)


class TestDocOrAssetClassification(unittest.TestCase):
    def test_recognizes_docs(self):
        self.assertTrue(is_doc_or_asset_file("README.md"))
        self.assertTrue(is_doc_or_asset_file("docs/architecture.md"))
        self.assertTrue(is_doc_or_asset_file("docs/guide.txt"))
        self.assertTrue(is_doc_or_asset_file("CHANGELOG.md"))
        self.assertTrue(is_doc_or_asset_file("LICENSE"))
        self.assertTrue(is_doc_or_asset_file(".gitignore"))

    def test_recognizes_assets(self):
        self.assertTrue(is_doc_or_asset_file("assets/image.png"))
        self.assertTrue(is_doc_or_asset_file("static/icons/app.ico"))
        self.assertTrue(is_doc_or_asset_file("diagram.pdf"))

    def test_rejects_code_and_config_files(self):
        self.assertFalse(is_doc_or_asset_file("triad/triad_engine.py"))
        self.assertFalse(is_doc_or_asset_file("src/components/App.tsx"))
        self.assertFalse(is_doc_or_asset_file("package.json"))
        self.assertFalse(is_doc_or_asset_file("pyproject.toml"))
        self.assertFalse(is_doc_or_asset_file("tsconfig.json"))
        self.assertFalse(is_doc_or_asset_file("requirements.txt"))
        self.assertFalse(is_doc_or_asset_file("requirements-dev.txt"))
        self.assertFalse(is_doc_or_asset_file("CMakeLists.txt"))
        self.assertFalse(is_doc_or_asset_file("docs/conf.py"))
        self.assertFalse(is_doc_or_asset_file("docs/schema.json"))
        self.assertFalse(is_doc_or_asset_file("tests/fixtures/data.txt"))
        self.assertFalse(is_doc_or_asset_file("bench/cases/case_001/prompt.txt"))

    def test_affects_code(self):
        self.assertFalse(_affects_code(["README.md", "docs/architecture.md", "LICENSE"]))
        self.assertTrue(_affects_code(["README.md", "requirements.txt"]))
        self.assertTrue(_affects_code(["docs/conf.py"]))
        self.assertTrue(_affects_code(["triad/procutil.py"]))

    def test_affects_typescript(self):
        self.assertTrue(_affects_typescript(["src/index.ts"]))
        self.assertTrue(_affects_typescript(["src/App.tsx"]))
        self.assertTrue(_affects_typescript(["src/App.vue"]))
        self.assertTrue(_affects_typescript(["src/App.svelte"]))
        self.assertTrue(_affects_typescript(["src/types/index.d.ts"]))
        self.assertTrue(_affects_typescript(["tsconfig.app.json"]))
        self.assertTrue(_affects_typescript(["tsconfig.node.json"]))
        self.assertTrue(_affects_typescript(["package.json"]))
        self.assertTrue(_affects_typescript(["bun.lockb"]))
        self.assertFalse(_affects_typescript(["README.md"]))
        self.assertFalse(_affects_typescript(["triad/triad_engine.py"]))
        self.assertFalse(_affects_typescript(["pyproject.toml"]))


class TestTargetedTestResolution(unittest.TestCase):
    def setUp(self):
        self.cwd = Path(__file__).resolve().parent.parent.parent
        _import_index.cache_clear()
        self.addCleanup(_import_index.cache_clear)

    def test_empty_or_none(self):
        self.assertEqual(_resolve_targeted_test_pattern([], self.cwd), "test_*.py")

    def test_test_file_itself(self):
        self.assertEqual(
            _resolve_targeted_test_pattern(["triad/tests/test_circuit.py"], self.cwd),
            "test_circuit.py"
        )
        self.assertEqual(
            _resolve_targeted_test_pattern(["tests/test_diff_bloat.py"], self.cwd),
            "test_diff_bloat.py"
        )

    def test_hermetic_module_resolution(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            tests_dir = repo / "triad" / "tests"
            tests_dir.mkdir(parents=True)
            (tests_dir / "test_widget.py").write_text("# test widget", encoding="utf-8")

            # Direct mapping
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/widget.py"], repo),
                "test_widget.py"
            )
            # Windows backslash path
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad\\widget.py"], repo),
                "test_widget.py"
            )
            # Mixed doc + code changes
            self.assertEqual(
                _resolve_targeted_test_pattern(["README.md", "triad/widget.py", "docs/info.txt"], repo),
                "test_widget.py"
            )
            # Nonexistent module falls back to test_*.py
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/unknown.py"], repo),
                "test_*.py"
            )

    def test_shared_module_with_importers_falls_back_to_all(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            tests_dir = triad_dir / "tests"
            tests_dir.mkdir()
            (triad_dir / "procutil.py").write_text("class Util: pass\n", encoding="utf-8")
            (triad_dir / "triad_engine.py").write_text("from triad.procutil import Util\n", encoding="utf-8")
            (tests_dir / "test_procutil.py").write_text("# test\n", encoding="utf-8")
            self.assertTrue(_has_importers("procutil", repo))
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/procutil.py"], repo),
                "test_*.py"
            )

    def test_core_engine_modules_fall_back_to_all(self):
        self.assertEqual(
            _resolve_targeted_test_pattern(["triad/triad_engine.py"], self.cwd),
            "test_*.py"
        )
        self.assertEqual(
            _resolve_targeted_test_pattern(["triad/worktree.py"], self.cwd),
            "test_*.py"
        )
        self.assertEqual(
            _resolve_targeted_test_pattern(["triad/competition.py"], self.cwd),
            "test_*.py"
        )
        self.assertEqual(
            _resolve_targeted_test_pattern(["triad/circuit.py"], self.cwd),
            "test_*.py"
        )

    def test_mixed_build_manifest_and_test_falls_back_to_all(self):
        self.assertEqual(
            _resolve_targeted_test_pattern(["pyproject.toml", "triad/tests/test_circuit.py"], self.cwd),
            "test_*.py"
        )
        self.assertEqual(
            _resolve_targeted_test_pattern(["package.json", "triad/tests/test_circuit.py"], self.cwd),
            "test_*.py"
        )
        self.assertEqual(
            _resolve_targeted_test_pattern(["requirements-dev.txt"], self.cwd),
            "test_*.py"
        )
        self.assertEqual(
            _resolve_targeted_test_pattern(["setup.cfg"], self.cwd),
            "test_*.py"
        )
        self.assertEqual(
            _resolve_targeted_test_pattern(["conftest.py"], self.cwd),
            "test_*.py"
        )

    def test_hermetic_importer_detection(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            tests_dir = triad_dir / "tests"
            tests_dir.mkdir()

            (triad_dir / "service.py").write_text("class Service:\n    pass\n", encoding="utf-8")
            (triad_dir / "consumer.py").write_text("from triad.service import Service\n", encoding="utf-8")
            (tests_dir / "test_service.py").write_text("# test\n", encoding="utf-8")
            (tests_dir / "test_consumer.py").write_text("# test\n", encoding="utf-8")

            # service is imported by consumer -> must fall back to test_*.py
            self.assertTrue(_has_importers("service", repo))
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/service.py"], repo),
                "test_*.py"
            )

            # consumer is not imported by any module -> resolves to test_consumer.py
            self.assertFalse(_has_importers("consumer", repo))
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/consumer.py"], repo),
                "test_consumer.py"
            )

    def test_non_python_file_matching_test_name_falls_back_to_all(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            tests_dir = repo / "tests"
            tests_dir.mkdir()
            (tests_dir / "test_config.py").write_text("# test\n", encoding="utf-8")
            # config.yaml must NOT map to test_config.py
            self.assertEqual(
                _resolve_targeted_test_pattern(["config.yaml"], repo),
                "test_*.py"
            )

    def test_syntax_error_in_code_falls_back_to_all(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            tests_dir = triad_dir / "tests"
            tests_dir.mkdir()
            # Broken syntax referencing leaf causes leaf to be marked as imported -> test_*.py
            (triad_dir / "broken.py").write_text("def broken(:\n    leaf.do_something()\n", encoding="utf-8")
            (triad_dir / "leaf.py").write_text("x = 1\n", encoding="utf-8")
            (tests_dir / "test_leaf.py").write_text("# test\n", encoding="utf-8")
            self.assertTrue(_has_importers("leaf", repo))
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/leaf.py"], repo),
                "test_*.py"
            )

            # Unrelated broken syntax does not prevent targeting leaf
            (triad_dir / "broken.py").write_text("def broken(:\n    something_else()\n", encoding="utf-8")
            _import_index.cache_clear()
            self.assertFalse(_has_importers("leaf", repo))
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/leaf.py"], repo),
                "test_leaf.py"
            )

    def test_imported_by_external_test_falls_back_to_all(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            tests_dir = triad_dir / "tests"
            tests_dir.mkdir()
            (triad_dir / "fixture.py").write_text("VAL = 42\n", encoding="utf-8")
            (tests_dir / "test_fixture.py").write_text("# test fixture\n", encoding="utf-8")
            # External test file imports fixture
            (tests_dir / "test_other.py").write_text("import triad.fixture\n", encoding="utf-8")
            self.assertTrue(_has_importers("fixture", repo))
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/fixture.py"], repo),
                "test_*.py"
            )

    def test_cli_parser_targeted_flags(self):
        parser = build_parser()

        args_gate_target = parser.parse_args(["gate", "--target", "test_circuit.py"])
        self.assertEqual(args_gate_target.target, "test_circuit.py")
        self.assertFalse(args_gate_target.targeted)

        args_gate_targeted = parser.parse_args(["gate", "--targeted"])
        self.assertTrue(args_gate_targeted.targeted)

        args_auto_target = parser.parse_args(["auto", "--target", "test_circuit.py"])
        self.assertEqual(args_auto_target.target, "test_circuit.py")
        self.assertFalse(args_auto_target.targeted)

        args_auto_targeted = parser.parse_args(["auto", "--targeted"])
        self.assertTrue(args_auto_targeted.targeted)

    def test_isolation_script_zero_matched_tests_fails(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            tests_dir = repo / "tests"
            tests_dir.mkdir()
            # Directory contains no test files matching test_nonexistent.py
            script = _build_python_isolation_script(repo, "tests", [], pattern="test_nonexistent.py")
            res = subprocess.run([sys.executable, "-c", script], cwd=str(repo), capture_output=True, text=True, timeout=30)
            self.assertEqual(res.returncode, 5)

    def test_dynamic_import_string_constant_indexed(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            tests_dir = triad_dir / "tests"
            tests_dir.mkdir()
            (triad_dir / "service.py").write_text("def run(): pass\n", encoding="utf-8")
            (tests_dir / "test_service.py").write_text("# test service\n", encoding="utf-8")
            # External test uses string reference in mock.patch
            (tests_dir / "test_unrelated.py").write_text('mock.patch("triad.service.run")\n', encoding="utf-8")
            self.assertTrue(_has_importers("service", repo))
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/service.py"], repo),
                "test_*.py"
            )

    def test_same_stem_importer_not_bypassed(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            other_dir = repo / "other"
            other_dir.mkdir(parents=True)
            (triad_dir / "service.py").write_text("class Service: pass\n", encoding="utf-8")
            # other/service.py has the same stem ("service"), but imports triad.service
            (other_dir / "service.py").write_text("import triad.service\n", encoding="utf-8")
            self.assertTrue(_has_importers("service", repo))

    def test_dot_triad_importer_not_bypassed(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            dot_triad_dir = repo / ".triad"
            dot_triad_dir.mkdir(parents=True)
            (triad_dir / "service.py").write_text("class Service: pass\n", encoding="utf-8")
            # .triad/service.py must not be stripped to triad/service.py
            (dot_triad_dir / "service.py").write_text("import triad.service\n", encoding="utf-8")
            self.assertTrue(_has_importers("service", repo))

    def test_check_apply_verified_safety_rejects_targeted_combinations(self):
        import argparse
        # 1. --apply-verified with explicit --target
        args_target = argparse.Namespace(apply_verified=True, target="test_circuit.py", targeted=False)
        with self.assertRaises(SystemExit) as ctx:
            _check_apply_verified_safety(args_target, {})
        self.assertEqual(ctx.exception.code, 1)

        # 2. --apply-verified with --targeted flag
        args_targeted = argparse.Namespace(apply_verified=True, target="", targeted=True)
        with self.assertRaises(SystemExit) as ctx:
            _check_apply_verified_safety(args_targeted, {})
        self.assertEqual(ctx.exception.code, 1)

        # 3. --apply-verified with TRIAD_TARGETED_TESTS="1" in env
        args_env = argparse.Namespace(apply_verified=True, target="", targeted=False)
        with self.assertRaises(SystemExit) as ctx:
            _check_apply_verified_safety(args_env, {"TRIAD_TARGETED_TESTS": "1"})
        self.assertEqual(ctx.exception.code, 1)

    def test_check_apply_verified_safety_allows_full_suite(self):
        import argparse
        # Default full suite execution allowed with --apply-verified
        args_safe = argparse.Namespace(apply_verified=True, target="", targeted=False)
        try:
            _check_apply_verified_safety(args_safe, {})
        except SystemExit:
            self.fail("_check_apply_verified_safety unexpectedly exited on valid full suite configuration")

    def test_cmd_auto_rejects_apply_verified_with_targeted(self):
        from triad.triad_engine import cmd_auto
        import argparse
        args = argparse.Namespace(
            apply_verified=True, target="test_foo.py", targeted=False,
            classify_only=False, worktree=False
        )
        with self.assertRaises(SystemExit) as ctx:
            cmd_auto(args, {})
        self.assertEqual(ctx.exception.code, 1)

    def test_normalize_target(self):
        self.assertEqual(_normalize_target("tests/test_*.py"), "test_*.py")
        self.assertEqual(_normalize_target("test_*.py"), "test_*.py")
        self.assertEqual(_normalize_target(""), "test_*.py")
        self.assertEqual(_normalize_target("circuit"), "test_circuit.py")
        self.assertEqual(_normalize_target("triad/competition.py"), "test_competition.py")
        self.assertEqual(_normalize_target("test_competition.py"), "test_competition.py")
        self.assertEqual(_normalize_target("test_circuit"), "test_circuit.py")
        self.assertEqual(_normalize_target("triad/tests"), "test_*.py")
        self.assertEqual(_normalize_target("tests/"), "test_*.py")
        self.assertEqual(_normalize_target("*.py"), "test_*.py")

    def test_apply_verified_allows_explicit_full_suite(self):
        import argparse
        args1 = argparse.Namespace(apply_verified=True, target="test_*.py", targeted=False)
        try:
            _check_apply_verified_safety(args1, {})
        except SystemExit:
            self.fail("_check_apply_verified_safety rejected explicit test_*.py")

        args2 = argparse.Namespace(apply_verified=True, target="tests/test_*.py", targeted=False)
        try:
            _check_apply_verified_safety(args2, {})
        except SystemExit:
            self.fail("_check_apply_verified_safety rejected explicit tests/test_*.py")

    def test_asset_file_rules(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            tests_dir = triad_dir / "tests"
            tests_dir.mkdir()
            prompts_dir = repo / "prompts"
            prompts_dir.mkdir()

            (prompts_dir / "system.md").write_text("prompt\n", encoding="utf-8")
            (triad_dir / "service.py").write_text('Path("prompts/system.md").read_text()\n', encoding="utf-8")
            (tests_dir / "test_service.py").write_text("# test\n", encoding="utf-8")

            # Document referenced as string in Python code triggers full suite
            self.assertTrue(_has_importers("system.md", repo))
            self.assertEqual(
                _resolve_targeted_test_pattern(["prompts/system.md"], repo),
                "test_*.py"
            )

            # Non-doc asset (e.g. data.json) triggers full suite
            (repo / "data.json").write_text("{}", encoding="utf-8")
            self.assertEqual(
                _resolve_targeted_test_pattern(["data.json"], repo),
                "test_*.py"
            )

    def test_skip_import_dirs_preserves_nested_worktrees(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            pkg_worktrees = repo / "mypkg" / "worktrees"
            pkg_worktrees.mkdir(parents=True)
            (pkg_worktrees / "manager.py").write_text("class Manager: pass\n", encoding="utf-8")
            (repo / "app.py").write_text("from mypkg.worktrees.manager import Manager\n", encoding="utf-8")

            idx = _import_index(repo)
            self.assertIsNotNone(idx)
            self.assertIn("manager", idx)
            self.assertIn("app.py", idx["manager"])

    def test_dynamic_import_fstring(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            tests_dir = triad_dir / "tests"
            tests_dir.mkdir()
            (triad_dir / "service.py").write_text("class Service: pass\n", encoding="utf-8")
            (tests_dir / "test_service.py").write_text("# test\n", encoding="utf-8")
            # Dynamic import using JoinedStr (f-string)
            (triad_dir / "runner.py").write_text('mod = "service"\nimportlib.import_module(f"triad.{mod}")\n', encoding="utf-8")
            self.assertTrue(_has_importers("service", repo))
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/service.py"], repo),
                "test_*.py"
            )

    def test_manifest_mentions_module_treated_as_imported(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            tests_dir = triad_dir / "tests"
            tests_dir.mkdir()
            (triad_dir / "cli.py").write_text("def run(): pass\n", encoding="utf-8")
            (tests_dir / "test_cli.py").write_text("# test\n", encoding="utf-8")
            # pyproject.toml defines script entry point pointing to cli
            (repo / "pyproject.toml").write_text('[project.scripts]\nmycmd = "triad.cli:run"\n', encoding="utf-8")
            self.assertTrue(_has_importers("cli", repo))
            self.assertEqual(
                _resolve_targeted_test_pattern(["triad/cli.py"], repo),
                "test_*.py"
            )

    def test_normalize_target_multi_pattern(self):
        self.assertEqual(
            _normalize_target("triad/diff_bloat.py,competition.py"),
            "test_competition.py,test_diff_bloat.py"
        )
        self.assertEqual(
            _normalize_target("test_a.py,test_b.py"),
            "test_a.py,test_b.py"
        )
        self.assertEqual(
            _normalize_target("test_a.py,tests/"),
            "test_*.py"
        )

    def test_resolve_targeted_multi_pattern_union(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            triad_dir = repo / "triad"
            triad_dir.mkdir(parents=True)
            tests_dir = triad_dir / "tests"
            tests_dir.mkdir()
            (triad_dir / "leaf1.py").write_text("class Leaf1: pass\n", encoding="utf-8")
            (triad_dir / "leaf2.py").write_text("class Leaf2: pass\n", encoding="utf-8")
            (tests_dir / "test_leaf1.py").write_text("# test leaf 1\n", encoding="utf-8")
            (tests_dir / "test_leaf2.py").write_text("# test leaf 2\n", encoding="utf-8")
            # Both leaf files modified
            resolved = _resolve_targeted_test_pattern(["triad/leaf1.py", "triad/leaf2.py"], repo)
            self.assertEqual(resolved, "test_leaf1.py,test_leaf2.py")

    def test_build_python_isolation_script_multi_patterns(self):
        script = _build_python_isolation_script(
            Path("."), "triad/tests", [], pattern="test_a.py,test_b.py"
        )
        self.assertIn("test_a.py", script)
        self.assertIn("test_b.py", script)
        self.assertIn("suite.addTest", script)
        self.assertIn("sys.meta_path", script)

    def test_build_python_multi_pattern_script(self):
        script = _build_python_multi_pattern_script(
            Path("."), "triad/tests", ["test_a.py", "test_b.py"]
        )
        self.assertIn("test_a.py", script)
        self.assertIn("test_b.py", script)
        self.assertIn("suite.addTest", script)
        self.assertIn("unittest.TestSuite()", script)

    def test_import_index_mtime_caching(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)
            self.addCleanup(_clear_import_index_caches)
            _clear_import_index_caches()
            f1 = repo / "mod1.py"
            # Equal byte length: "import json   \n"
            f1.write_text("import json   \n", encoding="utf-8")
            f1_str = str(f1)

            # Initial index population
            idx1 = _import_index(repo)
            self.assertIn("json", idx1)
            self.assertIn(f1_str, _FILE_IMPORT_CACHE)
            cached_entry = _FILE_IMPORT_CACHE[f1_str]
            self.assertIn("json", cached_entry[2])

            # Repeat indexing with unchanged file hits file-level AST cache even when lru_cache is cleared
            _import_index.cache_clear()
            idx2 = _import_index(repo)
            self.assertIn("json", idx2)
            self.assertIs(_FILE_IMPORT_CACHE[f1_str], cached_entry)

            # Modifying file with identical byte length but updated mtime via os.utime
            f1.write_text("import math   \n", encoding="utf-8")
            new_time = time.time() + 5.0
            os.utime(str(f1), (new_time, new_time))
            _import_index.cache_clear()
            idx3 = _import_index(repo)
            self.assertIn("math", idx3)
            self.assertNotIn("json", idx3)

            _clear_import_index_caches()
            self.assertEqual(len(_FILE_IMPORT_CACHE), 0)

    def test_parallel_arg_registered(self):
        parser = build_parser()
        gate_args = parser.parse_args(["gate", "--parallel"])
        self.assertTrue(gate_args.parallel)
        auto_args = parser.parse_args(["auto", "doctor", "--parallel"])
        self.assertTrue(auto_args.parallel)

    def test_resolve_pytest_xdist_cmd(self):
        from unittest.mock import patch
        with patch("triad.triad_engine.run_subprocess_tree_safe", return_value=(0, "", "")):
            cmd = _resolve_pytest_xdist_cmd("triad/tests")
            self.assertIsNotNone(cmd)
            self.assertIn("-n", cmd)
            self.assertIn("auto", cmd)
            self.assertIn("--dist=loadfile", cmd)
            self.assertIn("no:cacheprovider", " ".join(cmd))

        with patch("triad.triad_engine.run_subprocess_tree_safe", return_value=(1, "", "")):
            with patch("shutil.which", return_value=None):
                cmd_none = _resolve_pytest_xdist_cmd("triad/tests")
                self.assertIsNone(cmd_none)


if __name__ == "__main__":
    unittest.main()
