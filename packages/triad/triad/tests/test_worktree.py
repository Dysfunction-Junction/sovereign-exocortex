#!/usr/bin/env python3
"""
Unit tests for Triad Git Worktree Isolation (triad/worktree.py).
Verifies:
- Ephemeral worktree creation from HEAD or specific commits
- File writes, modifications, and dirty working trees inside worktrees
- Safe removal under Windows with locked handles and read-only attributes
- Clean state verification via `git worktree list`
- Context manager automatic cleanup and exception handling
"""

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from triad.worktree import (
    create_worktree,
    remove_worktree,
    isolated_worktree,
    list_worktrees,
    get_repo_root,
    prune_worktrees,
    WarmWorktreePool,
)

REPO_ROOT = get_repo_root(Path(__file__).resolve())


class TestGitWorktreeIsolation(unittest.TestCase):
    def setUp(self):
        # Ensure any leftover test worktrees are pruned before each test
        prune_worktrees(REPO_ROOT)
        self.initial_worktrees = list_worktrees(REPO_ROOT)
        self.initial_count = len(self.initial_worktrees)

    def tearDown(self):
        # Clean up and verify worktree list returns to initial state
        prune_worktrees(REPO_ROOT)
        current_worktrees = list_worktrees(REPO_ROOT)
        self.assertEqual(
            len(current_worktrees),
            self.initial_count,
            f"TearDown detected unpruned worktrees: {current_worktrees}"
        )

    def test_create_write_and_remove_worktree(self):
        """Verify creating, writing files inside, and explicitly removing a worktree."""
        wt = create_worktree(REPO_ROOT, branch_or_commit="HEAD", prefix="triad-test-cwr")
        self.assertTrue(wt.exists(), f"Worktree directory {wt} was not created")

        # Verify git tracks the new worktree
        wts_after_create = list_worktrees(REPO_ROOT)
        self.assertEqual(len(wts_after_create), self.initial_count + 1)
        self.assertTrue(any(w["worktree"] == wt for w in wts_after_create))

        # Write inside the worktree (simulating agent code generation)
        sub_dir = wt / "generated_module"
        sub_dir.mkdir(parents=True, exist_ok=True)
        code_file = sub_dir / "service.py"
        code_file.write_text("def run_task():\n    return 'success'\n", encoding="utf-8")
        self.assertTrue(code_file.exists())

        # Remove the worktree
        removed = remove_worktree(wt, force=True, repo_path=REPO_ROOT)
        self.assertTrue(removed, "remove_worktree did not return True")
        self.assertFalse(wt.exists(), "Worktree directory still exists on disk")

        # Verify git worktree list is completely clean
        wts_after_remove = list_worktrees(REPO_ROOT)
        self.assertEqual(len(wts_after_remove), self.initial_count)
        self.assertFalse(any(w["worktree"] == wt for w in wts_after_remove))

    def test_isolated_worktree_context_manager(self):
        """Verify isolated_worktree context manager cleans up automatically on exit."""
        target_path = None
        with isolated_worktree(REPO_ROOT, prefix="triad-test-cm") as wt:
            target_path = wt
            self.assertTrue(wt.exists())

            # Verify worktree registered in git
            wts = list_worktrees(REPO_ROOT)
            self.assertEqual(len(wts), self.initial_count + 1)

            # Create dirty uncommitted state
            (wt / "scratch.txt").write_text("uncommitted edits", encoding="utf-8")

        # After exiting context block, directory and git registration must be gone
        self.assertFalse(target_path.exists())
        wts_final = list_worktrees(REPO_ROOT)
        self.assertEqual(len(wts_final), self.initial_count)

    def test_isolated_worktree_with_exception_cleanup(self):
        """Verify isolated_worktree cleans up even if an exception is raised inside the block."""
        target_path = None
        with self.assertRaises(RuntimeError):
            with isolated_worktree(REPO_ROOT, prefix="triad-test-err") as wt:
                target_path = wt
                (wt / "broken.py").write_text("raise Exception()", encoding="utf-8")
                raise RuntimeError("Simulated agent pipeline failure")

        self.assertFalse(target_path.exists())
        self.assertEqual(len(list_worktrees(REPO_ROOT)), self.initial_count)

    def test_isolated_worktree_keep_worktree(self):
        """Verify keep_worktree=True preserves the worktree directory on exit."""
        target_path = None
        with isolated_worktree(REPO_ROOT, prefix="triad-test-keep", keep_worktree=True) as wt:
            target_path = wt
            (wt / "kept.txt").write_text("preserve me", encoding="utf-8")

        # Worktree should still exist because keep_worktree was True
        self.assertTrue(target_path.exists())
        self.assertEqual(len(list_worktrees(REPO_ROOT)), self.initial_count + 1)

        # Explicit manual cleanup
        remove_worktree(target_path, force=True, repo_path=REPO_ROOT)
        self.assertFalse(target_path.exists())

    def test_isolated_worktree_cd_mode(self):
        """Verify isolated_worktree with cd=True switches CWD and restores it without locking."""
        original_cwd = Path.cwd().resolve()
        target_path = None

        with isolated_worktree(REPO_ROOT, prefix="triad-test-cd", cd=True) as wt:
            target_path = wt
            current_cwd = Path.cwd().resolve()
            self.assertEqual(current_cwd, wt.resolve())

            # Perform file writes relative to CWD
            Path("relative_file.txt").write_text("written in worktree", encoding="utf-8")

        # Verify CWD restored and worktree deleted cleanly
        self.assertEqual(Path.cwd().resolve(), original_cwd)
        self.assertFalse(target_path.exists())

    def test_remove_worktree_with_readonly_files(self):
        """Verify remove_worktree handles Windows read-only file attributes cleanly."""
        wt = create_worktree(REPO_ROOT, prefix="triad-test-ro")
        ro_file = wt / "locked_file.txt"
        ro_file.write_text("read-only content", encoding="utf-8")

        # Set read-only attribute on Windows
        os.chmod(ro_file, stat.S_IREAD)

        # Removal must still succeed without PermissionError
        removed = remove_worktree(wt, force=True, repo_path=REPO_ROOT)
        self.assertTrue(removed)
        self.assertFalse(wt.exists())

    def test_cmd_auto_with_worktree_flag(self):
        """Verify cmd_auto --worktree executes inside ephemeral worktree and cleans up."""
        import argparse
        import io
        from unittest.mock import patch
        from triad.triad_engine import cmd_auto

        args = argparse.Namespace(
            prompt=["doctor"],
            worktree=True,
            ref="HEAD",
            diff_file="",
            context="",
            competition=False,
            engine="mock",
            cached=False,
            head=False
        )

        with patch("sys.stdout", new=io.StringIO()):
            cmd_auto(args)

        current_worktrees = list_worktrees(REPO_ROOT)
        self.assertEqual(len(current_worktrees), self.initial_count)

    def test_cmd_gate_with_worktree_flag(self):
        """Verify cmd_gate --worktree executes pre-commit gate in ephemeral worktree and cleans up."""
        import argparse
        import io
        from unittest.mock import patch
        from triad.triad_engine import cmd_gate

        args = argparse.Namespace(
            worktree=True,
            ref="HEAD",
            engine="mock",
            competition=False,
            max_retries=0,
            timeout=30
        )

        def fake_tree_safe(cmd, *a, **kw):
            cmd_str = " ".join(cmd)
            if "diff" in cmd_str or "status" in cmd_str or "read-tree" in cmd_str:
                return (0, "", "")
            if "write-tree" in cmd_str or "rev-parse" in cmd_str:
                return (0, "tree_123\n", "")
            return (0, "Ran 5 tests in 0.1s\nOK", "")

        with patch("sys.stdout", new=io.StringIO()):
            with patch("triad.triad_engine.run_subprocess_tree_safe", side_effect=fake_tree_safe):
                with patch("triad.triad_engine._verify_checkout_representation", return_value=[]):
                    cmd_gate(args)

        current_worktrees = list_worktrees(REPO_ROOT)
        self.assertEqual(len(current_worktrees), self.initial_count)

    def test_provision_deleted_candidate_workspace_package_fails_closed(self):
        """Verify that when a workspace package is deleted in candidate, it is never linked to parent source."""
        from triad.worktree import provision_worktree_dependencies, deprovision_worktree_dependencies
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td) / "repo"
            repo_root.mkdir()
            wt_root = Path(td) / "wt"
            wt_root.mkdir()

            # Parent has packages/foo and packages/bar
            (repo_root / "packages" / "foo").mkdir(parents=True)
            (repo_root / "packages" / "foo" / "index.js").write_text("parent foo", encoding="utf-8")
            (repo_root / "packages" / "bar").mkdir(parents=True)
            (repo_root / "packages" / "bar" / "index.js").write_text("parent bar", encoding="utf-8")

            # Parent node_modules links to workspace packages
            (repo_root / "node_modules").mkdir()
            try:
                os.symlink(str(repo_root / "packages" / "foo"), str(repo_root / "node_modules" / "foo"), target_is_directory=True)
                os.symlink(str(repo_root / "packages" / "bar"), str(repo_root / "node_modules" / "bar"), target_is_directory=True)
            except OSError:
                self.skipTest("Symlinks not permitted in this environment")

            # Candidate worktree ONLY has packages/bar (packages/foo is deleted in candidate!)
            (wt_root / "packages" / "bar").mkdir(parents=True)
            (wt_root / "packages" / "bar" / "index.js").write_text("candidate bar", encoding="utf-8")

            provision_worktree_dependencies(repo_root, wt_root)

            # wt/node_modules/bar should be retargeted to candidate packages/bar
            cand_bar_link = wt_root / "node_modules" / "bar"
            self.assertTrue(cand_bar_link.exists())
            self.assertEqual((cand_bar_link / "index.js").read_text(encoding="utf-8"), "candidate bar")

            # wt/node_modules/foo MUST NOT EXIST (fail closed on deleted workspace package!)
            cand_foo_link = wt_root / "node_modules" / "foo"
            self.assertFalse(cand_foo_link.exists(), "Deleted workspace package must never fall through to parent source!")

            # Deprovision safely
            deprovision_worktree_dependencies(wt_root)
            self.assertFalse(cand_bar_link.exists())

    def test_bin_provisioning_deleted_package_fails_closed(self):
        """Verify that .bin executables for deleted workspace packages are not provisioned into candidate."""
        from triad.worktree import provision_worktree_dependencies, deprovision_worktree_dependencies
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td) / "repo"
            repo_root.mkdir()
            wt_root = Path(td) / "wt"
            wt_root.mkdir()

            (repo_root / "packages" / "cli-tool").mkdir(parents=True)
            (repo_root / "packages" / "cli-tool" / "cli.js").write_text("console.log('hi')", encoding="utf-8")
            (repo_root / "node_modules" / ".bin").mkdir(parents=True)
            try:
                os.symlink(str(repo_root / "packages" / "cli-tool" / "cli.js"), str(repo_root / "node_modules" / ".bin" / "my-cli"))
            except OSError:
                self.skipTest("Symlinks not permitted in this environment")

            # Candidate does NOT have packages/cli-tool (deleted in candidate)
            provision_worktree_dependencies(repo_root, wt_root)

            # .bin/my-cli must NOT exist in candidate worktree
            cand_bin_cli = wt_root / "node_modules" / ".bin" / "my-cli"
            self.assertFalse(cand_bin_cli.exists(), "CLI wrapper for deleted workspace package must not be provisioned!")

            deprovision_worktree_dependencies(wt_root)

    def test_pnpm_layout_provisioning_order_and_external_manifest(self):
        """Verify .pnpm stores are provisioned first and manifest is stored strictly outside worktree checkout."""
        from triad.worktree import provision_worktree_dependencies, deprovision_worktree_dependencies, _get_provisioned_manifest_path
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td) / "repo"
            repo_root.mkdir()
            wt_root = Path(td) / "wt"
            wt_root.mkdir()

            parent_nm = repo_root / "node_modules"
            parent_nm.mkdir()

            # Set up .pnpm store with an unpacked package
            store_pkg = parent_nm / ".pnpm" / "fast-glob@3.0.0" / "node_modules" / "fast-glob"
            store_pkg.mkdir(parents=True)
            (store_pkg / "index.js").write_text("module.exports = 'fast-glob';", encoding="utf-8")
            (store_pkg / "cli.js").write_text("#!/usr/bin/env node\nconsole.log('fast');\n", encoding="utf-8")

            # Top-level symlink pointing into .pnpm store
            top_symlink = parent_nm / "fast-glob"
            try:
                os.symlink(str(store_pkg), str(top_symlink), target_is_directory=True)
            except OSError:
                self.skipTest("Symlinks not permitted in this environment")

            # .bin symlink pointing into .pnpm store
            bin_dir = parent_nm / ".bin"
            bin_dir.mkdir()
            os.symlink(str(store_pkg / "cli.js"), str(bin_dir / "fast-glob"))

            prov = provision_worktree_dependencies(repo_root, wt_root)
            self.assertTrue(any("node_modules" in p for p in prov))

            # 1. Manifest must NOT exist inside the worktree checkout
            checkout_manifest = wt_root / ".triad_provisioned_manifest.json"
            self.assertFalse(checkout_manifest.exists(), "Manifest must NEVER be written to the worktree checkout tree!")

            # 2. Manifest file exists in external storage path
            ext_manifest = _get_provisioned_manifest_path(wt_root)
            self.assertTrue(ext_manifest.exists(), f"External manifest must exist at {ext_manifest}")

            # 3. Top-level fast-glob was successfully provisioned and resolves into candidate worktree
            wt_fast_glob = wt_root / "node_modules" / "fast-glob"
            self.assertTrue(wt_fast_glob.exists())
            self.assertEqual((wt_fast_glob / "index.js").read_text(encoding="utf-8"), "module.exports = 'fast-glob';")

            # 4. .bin/fast-glob was successfully provisioned
            wt_bin = wt_root / "node_modules" / ".bin" / "fast-glob"
            self.assertTrue(wt_bin.exists())

            # 5. Deprovision cleans up completely
            deprovision_worktree_dependencies(wt_root)
            self.assertFalse(wt_fast_glob.exists())
            self.assertFalse(ext_manifest.exists())

    def test_deprovision_untrusted_manifest_containment_and_rejection(self):
        """Verify deprovisioning rejects untrusted manifest paths escaping the worktree dependency folder."""
        import json
        from triad.worktree import deprovision_worktree_dependencies, _get_provisioned_manifest_path
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td) / "repo"
            repo_root.mkdir()
            wt_root = Path(td) / "wt"
            wt_root.mkdir()

            sensitive_file = repo_root / "critical_data.txt"
            sensitive_file.write_text("vital user content", encoding="utf-8")

            # Write forged manifest targeting the parent repo file
            manifest_file = _get_provisioned_manifest_path(wt_root)
            manifest_file.parent.mkdir(parents=True, exist_ok=True)
            forged_payload = {
                "version": 1,
                "worktree": str(wt_root.resolve()),
                "entries": [
                    str(sensitive_file.resolve()),
                    str(Path(td).resolve())
                ]
            }
            manifest_file.write_text(json.dumps(forged_payload), encoding="utf-8")

            # Run deprovisioning: must reject escaping entries
            deprovision_worktree_dependencies(wt_root)

            # Sensitive file MUST still exist intact!
            self.assertTrue(sensitive_file.exists())
            self.assertEqual(sensitive_file.read_text(encoding="utf-8"), "vital user content")

    def test_node_provisioning_to_gate_integration(self):
        """Verify provisioned dependencies pass pre-validation checks without untracked manifest errors."""
        from triad.worktree import provision_worktree_dependencies, deprovision_worktree_dependencies
        from triad.triad_engine import _check_no_uncommitted_source_dependencies, clean_git_env

        with tempfile.TemporaryDirectory() as td:
            repo = Path(td) / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", str(repo)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@test.com"], check=True)

            (repo / "package.json").write_text('{"name": "test-pkg"}', encoding="utf-8")
            (repo / "index.js").write_text("console.log('hi');\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-m", "init"], check=True, capture_output=True)

            # Parent node_modules
            parent_nm = repo / "node_modules"
            parent_nm.mkdir()
            (parent_nm / "dep-pkg").mkdir()
            (parent_nm / "dep-pkg" / "index.js").write_text("dep content", encoding="utf-8")

            # Create worktree
            wt = Path(td) / "wt"
            subprocess.run(["git", "-C", str(repo), "worktree", "add", "--detach", str(wt), "HEAD"], check=True, capture_output=True)

            # Provision dependencies
            prov = provision_worktree_dependencies(repo, wt)
            self.assertTrue(len(prov) > 0)

            # Verify no untracked manifest in checkout
            self.assertFalse((wt / ".triad_provisioned_manifest.json").exists())

            # Run pre-validation source dependency check inside worktree: MUST PASS!
            exec_env = clean_git_env()
            _check_no_uncommitted_source_dependencies(wt, exec_env, in_worktree=True, stage_name="pre-validation")

            # Deprovision
            deprovision_worktree_dependencies(wt)
            subprocess.run(["git", "-C", str(repo), "worktree", "remove", "--force", str(wt)], check=True, capture_output=True)

    def test_warm_worktree_pool_recycling_and_concurrency_bound(self):
        """Verify WarmWorktreePool bounds concurrency <= 2, recycles dirty state, and leaves 0 leaks."""
        # Non-negotiable #2: Bounded concurrency <= 2
        pool = WarmWorktreePool(REPO_ROOT, max_workers=5, prefix="triad-test-warm")
        self.assertEqual(pool.max_workers, 2, "WarmWorktreePool failed to cap max_workers at 2")

        with pool:
            # First acquisition: dirty the worktree with an untracked file and committed file
            with pool.acquire() as wt1:
                self.assertTrue(wt1.exists())
                dirty_file = wt1 / "dirty_test_file.txt"
                dirty_file.write_text("temporary dirty data", encoding="utf-8")
                subprocess.run(["git", "-C", str(wt1), "add", str(dirty_file)], capture_output=True)
                subprocess.run(
                    ["git", "-C", str(wt1), "-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "Temp commit"],
                    capture_output=True
                )
                untracked_file = wt1 / "untracked.log"
                untracked_file.write_text("untracked", encoding="utf-8")

            # Second acquisition of the recycled worktree: must be 100% clean
            with pool.acquire() as wt2:
                self.assertFalse((wt2 / "dirty_test_file.txt").exists(), "Recycled worktree retained committed file")
                self.assertFalse((wt2 / "untracked.log").exists(), "Recycled worktree retained untracked file")

        # After pool context exits, worktrees must be pruned
        prune_worktrees(REPO_ROOT)
        current_wts = list_worktrees(REPO_ROOT)
        self.assertEqual(len(current_wts), self.initial_count, "WarmWorktreePool leaked worktrees after exit")

    def test_warm_worktree_pool_unique_paths_across_pools(self):
        """Verify multiple pools in the same process have distinct pool_ids and worktree paths."""
        pool1 = WarmWorktreePool(REPO_ROOT, max_workers=1, prefix="triad-test-p1")
        pool2 = WarmWorktreePool(REPO_ROOT, max_workers=1, prefix="triad-test-p2")
        self.assertNotEqual(pool1._pool_id, pool2._pool_id)

        try:
            with pool1.acquire() as wt1:
                with pool2.acquire() as wt2:
                    self.assertNotEqual(wt1, wt2)
                    self.assertTrue(wt1.exists())
                    self.assertTrue(wt2.exists())
        finally:
            pool1.close()
            pool2.close()
            prune_worktrees(REPO_ROOT)

    def test_warm_worktree_pool_quarantine_corrupted_worktree(self):
        """Verify corrupted worktrees that fail git reset are quarantined and replaced."""
        pool = WarmWorktreePool(REPO_ROOT, max_workers=1, prefix="triad-test-quarantine")
        with pool:
            with pool.acquire() as wt:
                corrupted_wt = wt
                # Break the git repository metadata inside worktree to force reset failure
                git_ref = wt / ".git"
                if git_ref.is_file():
                    if os.name == "nt":
                        subprocess.run(["attrib", "-h", "-r", str(git_ref)], capture_output=True)
                    git_ref.write_text("gitdir: /nonexistent/path/that/does/not/exist", encoding="utf-8")

            # Acquiring again must quarantine the broken worktree and return a healthy replacement
            with pool.acquire() as replacement_wt:
                self.assertTrue(replacement_wt.exists())
                self.assertNotEqual(str(corrupted_wt), str(replacement_wt))
                # Healthy replacement can run git status
                res = subprocess.run(["git", "-C", str(replacement_wt), "status"], capture_output=True)
                self.assertEqual(res.returncode, 0)

    def test_warm_worktree_pool_lease_drain_on_close(self):
        """Verify close() unblocks waiters and handles active leases cleanly."""
        import threading
        import time

        pool = WarmWorktreePool(REPO_ROOT, max_workers=1, prefix="triad-test-lease")
        pool.prewarm()

        acquired_event = threading.Event()
        finish_event = threading.Event()
        worker_error = []

        def worker():
            try:
                with pool.acquire():
                    acquired_event.set()
                    finish_event.wait(timeout=5)
            except Exception as e:
                worker_error.append(e)

        t = threading.Thread(target=worker)
        t.start()
        acquired_event.wait(timeout=5)

        # Worker holds the single worktree in pool; now call close() in another thread
        close_done = threading.Event()
        def closer():
            pool.close(timeout=5)
            close_done.set()

        t_close = threading.Thread(target=closer)
        t_close.start()

        # Release worker lease
        time.sleep(0.1)
        finish_event.set()

        t.join(timeout=5)
        t_close.join(timeout=5)
        self.assertTrue(close_done.is_set())
        self.assertEqual(worker_error, [])
        self.assertTrue(pool._closed)

    def test_warm_worktree_pool_deferred_lease_teardown(self):
        """Verify worktrees still leased during close timeout are preserved until lease exit."""
        import threading

        pool = WarmWorktreePool(REPO_ROOT, max_workers=1, prefix="triad-test-defer")
        pool.prewarm()

        acquired_event = threading.Event()
        finish_event = threading.Event()
        saved_wt = []
        worker_error = []

        def worker():
            try:
                with pool.acquire() as wt:
                    saved_wt.append(wt)
                    acquired_event.set()
                    finish_event.wait(timeout=5)
                    if not wt.exists():
                        worker_error.append("Worktree deleted prematurely during active lease")
            except Exception as exc:
                worker_error.append(repr(exc))
                acquired_event.set()

        t = threading.Thread(target=worker)
        t.start()
        acquired_event.wait(timeout=5)

        # Close pool with short timeout while worker is actively inside lease
        pool.close(timeout=0.1)
        self.assertTrue(pool._closed)
        wt = saved_wt[0]
        # Active worktree was NOT deleted by close() because it was leased!
        self.assertTrue(wt.exists())

        # Now finish the lease
        finish_event.set()
        t.join(timeout=5)

        # After lease releases, the deferred teardown unlinks the worktree
        self.assertEqual(worker_error, [])
        self.assertFalse(wt.exists(), "Worktree was not unlinked on deferred lease exit!")

    def test_extract_base_files_needed_with_spaces_quotes_and_renames(self):
        """Verify extract_base_files_needed correctly handles spaces, C-quotes, deletions, and renames."""
        from triad.bench.swebench_runner import extract_base_files_needed, extract_files_from_diff

        # 1. Diff with spaces and timestamps
        diff_spaces = (
            "--- a/path with spaces/source file.py\t2026-10-04 02:00:00\n"
            "+++ b/path with spaces/source file.py\t2026-10-04 02:05:00\n"
            "@@ -1,3 +1,3 @@\n"
            "-old line\n"
            "+new line\n"
        )
        base = extract_base_files_needed(diff_spaces)
        self.assertEqual(base, ["path with spaces/source file.py"])
        all_files = extract_files_from_diff(diff_spaces)
        self.assertEqual(all_files, ["path with spaces/source file.py"])

        # 2. Diff with Git C-style quotes
        diff_quotes = (
            '--- "a/folder with \\"quotes\\"/module.py"\n'
            '+++ "b/folder with \\"quotes\\"/module.py"\n'
            "@@ -10,2 +10,2 @@\n"
            "-print(1)\n"
            "+print(2)\n"
        )
        base_quotes = extract_base_files_needed(diff_quotes)
        self.assertEqual(base_quotes, ['folder with "quotes"/module.py'])

        # 3. Rename with spaces
        diff_rename = (
            "diff --git a/old name with spaces.py b/new name with spaces.py\n"
            "similarity index 95%\n"
            "rename from old name with spaces.py\n"
            "rename to new name with spaces.py\n"
            "--- a/old name with spaces.py\n"
            "+++ b/new name with spaces.py\n"
            "@@ -1,2 +1,2 @@\n"
            "-a\n"
            "+b\n"
        )
        base_rename = extract_base_files_needed(diff_rename)
        self.assertEqual(base_rename, ["old name with spaces.py"])
        all_rename = extract_files_from_diff(diff_rename)
        self.assertEqual(all_rename, ["new name with spaces.py", "old name with spaces.py"])

        # 4. Newly created file (/dev/null -> destination)
        diff_new = (
            "--- /dev/null\n"
            "+++ b/created file.py\n"
            "@@ -0,0 +1,5 @@\n"
            "+def hello(): pass\n"
        )
        base_new = extract_base_files_needed(diff_new)
        self.assertEqual(base_new, [], "/dev/null should not be in needed base files")

        # 5. Deletion (source removed, destination /dev/null)
        diff_del = (
            "--- a/removed file.py\n"
            "+++ /dev/null\n"
            "@@ -1,1 +0,0 @@\n"
            "-gone\n"
        )
        self.assertEqual(extract_base_files_needed(diff_del), ["removed file.py"])
        self.assertEqual(extract_files_from_diff(diff_del), ["removed file.py"])

        # 6. Git C-quoted non-ASCII (octal UTF-8 bytes, not unicode code points)
        diff_cafe = (
            "--- \"a/caf\\303\\251.py\"\n"
            "+++ \"b/caf\\303\\251.py\"\n"
            "@@ -1 +1 @@\n"
            "-a\n"
            "+b\n"
        )
        self.assertEqual(extract_base_files_needed(diff_cafe), ["café.py"])

        # 7. Hunk body lines that look like ---/+++ headers are not file paths
        diff_hunk = (
            "--- a/real.py\n"
            "+++ b/real.py\n"
            "@@ -1,1 +1,1 @@\n"
            "--- not a header\n"
            "+++ also not a header\n"
        )
        self.assertEqual(extract_base_files_needed(diff_hunk), ["real.py"])
        self.assertEqual(extract_files_from_diff(diff_hunk), ["real.py"])

        # 8. Over-long hunk counts must not hide the next file header
        diff_overcount = (
            "--- a/first.py\n"
            "+++ b/first.py\n"
            "@@ -1,5 +1,5 @@\n"
            "-old\n"
            "--- a/second.py\n"
            "+++ b/second.py\n"
            "@@ -1,1 +1,1 @@\n"
            "-x\n"
            "+y\n"
        )
        self.assertEqual(extract_base_files_needed(diff_overcount), ["first.py", "second.py"])
        self.assertEqual(extract_files_from_diff(diff_overcount), ["first.py", "second.py"])

    def test_model_session_limiter_bounds_concurrency(self):
        """Verify ModelSessionLimiter strictly bounds concurrent executions to max_concurrent."""
        import tempfile
        import threading
        import time
        from triad.advisor_manager import ModelSessionLimiter

        slot_dir = tempfile.mkdtemp(prefix="triad-session-slots-")
        try:
            limiter = ModelSessionLimiter(max_concurrent=2, timeout=5.0, slot_dir=slot_dir)
            active_count = 0
            peak_count = 0
            lock = threading.Lock()
            barrier = threading.Barrier(2)

            def worker():
                nonlocal active_count, peak_count
                with limiter.acquire(timeout=5.0):
                    with lock:
                        active_count += 1
                        if active_count > peak_count:
                            peak_count = active_count
                    try:
                        barrier.wait(timeout=2.0)
                    except threading.BrokenBarrierError:
                        pass
                    time.sleep(0.05)
                    with lock:
                        active_count -= 1

            threads = [threading.Thread(target=worker) for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=10.0)
                self.assertFalse(t.is_alive(), "session worker did not finish")

            self.assertEqual(peak_count, 2, f"Expected the two allowed sessions to overlap, peak was {peak_count}")
        finally:
            import shutil
            shutil.rmtree(slot_dir, ignore_errors=True)

    def test_require_git_toplevel_refuses_parent_walk(self):
        """A directory that is not its own git root must not be reset or cleaned."""
        from triad.worktree import require_git_toplevel

        with tempfile.TemporaryDirectory() as tmp:
            nested = Path(tmp) / "not-a-repo"
            nested.mkdir()
            with self.assertRaises(RuntimeError):
                require_git_toplevel(nested)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q", str(root)], check=True, capture_output=True)
            require_git_toplevel(root)
            child = root / "child"
            child.mkdir()
            with self.assertRaises(RuntimeError):
                require_git_toplevel(child)


if __name__ == "__main__":
    unittest.main(verbosity=2)

