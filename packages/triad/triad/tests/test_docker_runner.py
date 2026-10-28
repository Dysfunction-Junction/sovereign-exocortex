#!/usr/bin/env python3
"""
Tests for the container-backed VerificationRunner (docker_runner.py).

Unit tests use an injected fake subprocess runner and always run. The integration class talks to a
real Docker daemon and is skipped when none is reachable; it proves the actual isolation properties.
"""

import os
import subprocess
import sys
import time
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from triad.docker_runner import DockerRunner, IsolationUnavailable, OutputLimitExceeded, _container_user, bounded_run
from triad.morphogenetic import MorphogeneticEngine, MutationCandidate
from triad.tests.test_morphogenetic import FakeRunner, _make_repo, _Engine

PROFILES = {"unit": ["python", "-m", "unittest", "-q"], "pwd": ["python", "-c", "print('hi')"]}


class FakeDocker:
    """Records every docker CLI call; behaves like a healthy daemon unless told otherwise."""

    def __init__(self, info_rc=0, run_rc=0, stdout="ok", stderr="", run_raises=None):
        self.calls = []
        self.info_rc = info_rc
        self.run_rc = run_rc
        self.stdout = stdout
        self.stderr = stderr
        self.run_raises = run_raises

    def __call__(self, cmd, **kw):
        self.calls.append((list(cmd), kw))
        if cmd[1] == "info":
            return subprocess.CompletedProcess(cmd, self.info_rc, "27.0.1\n" if self.info_rc == 0 else "", "" if self.info_rc == 0 else "Cannot connect to the Docker daemon")
        if cmd[1] == "run":
            if self.run_raises:
                raise self.run_raises
            return subprocess.CompletedProcess(cmd, self.run_rc, self.stdout, self.stderr)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    def verbs(self):
        return [c[1] for c, _ in self.calls]

    def run_cmd(self):
        return next(c for c, _ in self.calls if c[1] == "run")


class TestDockerRunnerCommand(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.ws = Path(self._td.name).resolve()
        self.docker = FakeDocker()
        self.runner = DockerRunner(PROFILES, runner=self.docker, docker_bin="docker")

    def _cmd(self):
        self.runner.run(workspace=self.ws, profile="unit", timeout=30)
        return self.docker.run_cmd()

    def test_isolation_flags_are_all_present(self):
        cmd = " ".join(self._cmd())
        for flag in (
            "--network none", "--ipc none", "--cap-drop ALL", "--security-opt no-new-privileges",
            "--read-only", "--pull never", "--pids-limit 256",
            "--memory 1g", "--memory-swap 1g", "--rm",
        ):
            self.assertIn(flag, cmd)
        self.assertIn(f"--user {_container_user()}", cmd)

    def test_user_is_host_uid_gid_and_root_is_refused(self):
        with mock.patch("triad.docker_runner.sys.platform", "linux"),                 mock.patch("triad.docker_runner.os.getuid", create=True, return_value=1234),                 mock.patch("triad.docker_runner.os.getgid", create=True, return_value=5678):
            self.assertEqual(_container_user(), "1234:5678")
            self.assertIn("--user 1234:5678", " ".join(self._cmd()))
        for uid, gid in ((0, 1000), (1000, 0)):
            with mock.patch("triad.docker_runner.sys.platform", "linux"),                     mock.patch("triad.docker_runner.os.getuid", create=True, return_value=uid),                     mock.patch("triad.docker_runner.os.getgid", create=True, return_value=gid):
                with self.assertRaises(IsolationUnavailable):
                    self.runner.build_command(self.ws, "unit", "n")

    def test_user_falls_back_to_nobody_off_linux(self):
        with mock.patch("triad.docker_runner.sys.platform", "win32"):
            self.assertEqual(_container_user(), "65534:65534")

    def test_only_the_workspace_is_mounted(self):
        cmd = self._cmd()
        mounts = [cmd[i + 1] for i, a in enumerate(cmd) if a == "--mount"]
        self.assertEqual(mounts, [f"type=bind,src={self.ws},dst=/work"])
        self.assertNotIn("-v", cmd)
        self.assertNotIn("--volume", cmd)

    def test_no_host_environment_is_passed_through(self):
        os.environ["TRIAD_TEST_SECRET"] = "s3cr3t-value"
        self.addCleanup(os.environ.pop, "TRIAD_TEST_SECRET", None)
        cmd = self._cmd()
        self.assertNotIn("s3cr3t-value", " ".join(cmd))
        self.assertNotIn("--env-file", cmd)
        envs = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-e"]
        self.assertTrue(all("=" in e and e.split("=")[0] in ("PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING", "PYTHONUTF8", "HOME") for e in envs))

    def test_profile_argv_comes_after_the_image_and_unknown_profiles_are_refused(self):
        cmd = self._cmd()
        self.assertEqual(cmd[-4:], PROFILES["unit"])
        self.assertEqual(cmd[-5], self.runner.image)
        with self.assertRaises(KeyError):
            self.runner.run(workspace=self.ws, profile="rm-rf", timeout=5)

    def test_workspace_paths_that_could_smuggle_mount_options_are_refused(self):
        for bad in ("a,b", 'a"b'):
            with self.assertRaises(ValueError):
                self.runner.build_command(Path(self.ws / bad), "unit", "n")

    def test_invalid_profiles_are_rejected_at_construction(self):
        for bad in ({"x": []}, {"x": [""]}, {"x": ["python", 3]}):
            with self.assertRaises(ValueError):
                DockerRunner(bad, runner=self.docker)

    def test_unavailable_daemon_raises_and_never_runs_anything(self):
        docker = FakeDocker(info_rc=1)
        runner = DockerRunner(PROFILES, runner=docker, docker_bin="docker")
        with self.assertRaises(IsolationUnavailable):
            runner.run(workspace=self.ws, profile="unit", timeout=5)
        self.assertNotIn("run", docker.verbs())

    def test_timeout_kills_the_container_and_reraises(self):
        docker = FakeDocker(run_raises=subprocess.TimeoutExpired(["docker"], 5))
        runner = DockerRunner(PROFILES, runner=docker, docker_bin="docker")
        with self.assertRaises(subprocess.TimeoutExpired):
            runner.run(workspace=self.ws, profile="unit", timeout=5)
        name = docker.run_cmd()[docker.run_cmd().index("--name") + 1]
        removals = [c for c, _ in docker.calls if c[1] == "rm"]
        self.assertTrue(removals and removals[0][-1] == name and "-f" in removals[0])

    def test_container_is_always_removed_even_on_success(self):
        self._cmd()
        self.assertIn("rm", self.docker.verbs())

    def test_output_is_capped(self):
        docker = FakeDocker(stdout="x" * 5000)
        runner = DockerRunner(PROFILES, runner=docker, docker_bin="docker", max_output_bytes=100)
        res = runner.run(workspace=self.ws, profile="unit", timeout=5)
        self.assertLess(len(res.stdout), 200)
        self.assertIn("[output truncated]", res.stdout)

    def test_nonzero_exit_is_returned_not_raised(self):
        docker = FakeDocker(run_rc=1, stderr="boom")
        runner = DockerRunner(PROFILES, runner=docker, docker_bin="docker")
        res = runner.run(workspace=self.ws, profile="unit", timeout=5)
        self.assertEqual((res.returncode, res.stderr), (1, "boom"))


class TestEngineGitPointerGuard(unittest.TestCase):
    """Verified code runs in a directory the host later runs git in: the .git pointer must not move."""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.repo = _make_repo(self._td.name)

    def _cand(self):
        return MutationCandidate("c1", "d", "src/app.py", "", "a = 1\nb = 99\n")

    def test_rewriting_the_git_pointer_is_rejected(self):
        def tamper(ws):
            # "r+b": plain write mode cannot truncate the hidden .git file on Windows, r+b can.
            with open(ws / ".git", "r+b") as f:
                f.write(b"gitdir: ./evil\n")
                f.truncate()

        cand = self._cand()
        engine = _Engine(self.repo, verification_runner=FakeRunner(side_effect=tamper))
        self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
        self.assertIn("git pointer", cand.verification_output)
        self.assertFalse(cand.survival_passed)
        self.assertEqual(cand.unified_diff, "")

    def test_untouched_pointer_still_survives(self):
        cand = self._cand()
        engine = _Engine(self.repo, verification_runner=FakeRunner())
        self.assertTrue(engine.evaluate_mutation_in_sandbox(cand, "unit"))


def _daemon_up():
    ok, _ = DockerRunner({"p": ["true"]}).available()
    return ok


# CI sets TRIAD_SKIP_REAL_DOCKER=1 for the blocking job and runs this class in its own informational job.
@unittest.skipIf(os.environ.get("TRIAD_SKIP_REAL_DOCKER") == "1", "real-Docker isolation runs in its own CI job")
@unittest.skipUnless(_daemon_up(), "no reachable Docker daemon")
class TestDockerRunnerRealIsolation(unittest.TestCase):
    """Runs real containers. Each case executes hostile-looking code and asserts it is contained."""

    @classmethod
    def setUpClass(cls):
        cls.probe = DockerRunner({"p": ["true"]})
        cls.probe.ensure_image()

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.ws = Path(self._td.name).resolve()
        # Deliberately left 0700 and owned by the host user, as real workspaces are: the container runs as that user.
        self.assertEqual(os.stat(self.ws).st_mode & 0o777, 0o700)

    def _run(self, code, timeout=60, **kw):
        runner = DockerRunner({"t": ["python", "-c", code]}, **kw)
        return runner.run(workspace=self.ws, profile="t", timeout=timeout)

    def test_runs_unprivileged(self):
        res = self._run("import os; print(os.getuid(), os.geteuid())")
        self.assertEqual(res.returncode, 0, res.stderr)
        if hasattr(os, "getuid") and sys.platform.startswith("linux"):
            self.assertEqual(res.stdout.split(), [str(os.getuid())] * 2)
        else:
            self.assertEqual(res.stdout.split(), ["65534", "65534"])
        self.assertNotEqual(res.stdout.split()[0], "0")

    @unittest.skipUnless(sys.platform.startswith("linux"), "host-uid containers are Linux only")
    def test_private_workspace_is_readable_and_writable(self):
        (self.ws / "seed.txt").write_text("hello", encoding="utf-8")
        os.chmod(self.ws / "seed.txt", 0o600)
        res = self._run(
            "import os\n"
            "print(open('/work/seed.txt').read(), os.access('/work', os.W_OK))\n"
            "open('/work/out.txt', 'w').write('x')\n"
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(res.stdout.split(), ["hello", "True"])
        self.assertTrue((self.ws / "out.txt").exists())
        self.assertEqual(os.stat(self.ws).st_mode & 0o777, 0o700)

    def test_network_is_unreachable(self):
        res = self._run(
            "import socket\n"
            "try:\n"
            "    socket.create_connection(('1.1.1.1', 53), timeout=3)\n"
            "    print('CONNECTED')\n"
            "except OSError as e:\n"
            "    print('BLOCKED')\n"
        )
        self.assertIn("BLOCKED", res.stdout)
        self.assertNotIn("CONNECTED", res.stdout)

    def test_host_environment_secrets_are_invisible(self):
        os.environ["TRIAD_TEST_SECRET"] = "s3cr3t-value"
        self.addCleanup(os.environ.pop, "TRIAD_TEST_SECRET", None)
        res = self._run("import os; print(sorted(os.environ))")
        self.assertNotIn("TRIAD_TEST_SECRET", res.stdout)
        self.assertNotIn("s3cr3t-value", res.stdout + res.stderr)

    def test_host_files_outside_the_workspace_are_invisible(self):
        marker = Path(tempfile.gettempdir()) / f"triad-host-marker-{os.getpid()}.txt"
        marker.write_text("host-only", encoding="utf-8")
        self.addCleanup(marker.unlink)
        res = self._run(
            "import os\n"
            "print('C:' , os.path.exists('/mnt/c'), os.path.exists('/Users'), os.listdir('/work'))\n"
        )
        self.assertIn("False False", res.stdout)

    def test_root_filesystem_is_read_only_but_workspace_and_tmp_are_writable(self):
        res = self._run(
            "import os\n"
            "def can(p):\n"
            "    try:\n"
            "        open(p, 'w').write('x'); return True\n"
            "    except OSError:\n"
            "        return False\n"
            "print(can('/etc/triad-test'), can('/work/out.txt'), can('/tmp/out.txt'))\n"
        )
        self.assertIn("False True True", res.stdout, res.stderr)
        self.assertTrue((self.ws / "out.txt").exists())  # workspace writes are how a candidate's tests may legitimately emit files

    def test_fork_bomb_is_contained_by_the_pid_limit(self):
        res = self._run(
            "import os, sys\n"
            "n = 0\n"
            "try:\n"
            "    while n < 2000:\n"
            "        pid = os.fork()\n"
            "        if pid == 0:\n"
            "            import time; time.sleep(5); os._exit(0)\n"
            "        n += 1\n"
            "except OSError:\n"
            "    pass\n"
            "print('forked', n)\n",
            pids_limit=64,
        )
        count = int(res.stdout.split()[-1])
        self.assertLess(count, 64)

    def test_memory_hog_is_killed(self):
        res = self._run("x = bytearray(2 * 1024 * 1024 * 1024)\nprint('ALLOCATED')\n", memory="256m")
        self.assertNotIn("ALLOCATED", res.stdout)
        self.assertNotEqual(res.returncode, 0)

    def test_timeout_kills_the_container(self):
        runner = DockerRunner({"t": ["python", "-c", "import time; time.sleep(120)"]})
        with self.assertRaises(subprocess.TimeoutExpired):
            runner.run(workspace=self.ws, profile="t", timeout=5)
        left = subprocess.run(
            ["docker", "ps", "-aq", "--filter", "label=triad-verify=1"], capture_output=True, text=True
        ).stdout.split()
        self.assertEqual(left, [], "timed-out container must not survive")

    def _bug_repo(self):
        repo = Path(tempfile.mkdtemp(prefix="triad-e2e-")).resolve()
        self.addCleanup(lambda: __import__("shutil").rmtree(repo, ignore_errors=True))
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / "calc.py").write_bytes(b"def add(a, b):\n    return a - b\n")
        (repo / "test_calc.py").write_bytes(
            b"import unittest\nfrom calc import add\n\n"
            b"class T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\n"
            b"if __name__ == '__main__':\n    unittest.main()\n"
        )
        base = ["git", "-C", str(repo), "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "core.autocrlf=false"]
        subprocess.run(base + ["add", "-A"], check=True)
        subprocess.run(base + ["commit", "-qm", "init"], check=True)
        return repo

    def test_engine_verifies_a_real_repair_inside_a_container(self):
        repo = self._bug_repo()
        runner = DockerRunner({"calc": ["python", "-m", "unittest", "test_calc"]})
        engine = _Engine(repo, verification_runner=runner)
        good = MutationCandidate("good", "fix add", "calc.py", "", "def add(a, b):\n    return a + b\n")
        self.assertTrue(engine.evaluate_mutation_in_sandbox(good, "calc"), good.verification_output)
        self.assertIn("+    return a + b", good.unified_diff)

        bad = MutationCandidate("bad", "still wrong", "calc.py", "", "def add(a, b):\n    return a * b\n")
        self.assertFalse(engine.evaluate_mutation_in_sandbox(bad, "calc"))
        self.assertFalse(bad.survival_passed)

    def test_candidate_that_phones_home_or_reads_host_files_cannot_succeed_by_doing_so(self):
        repo = self._bug_repo()
        # A "repair" whose import-time code tries the network and a host path; the container makes both fail,
        # and the assertions in its own code turn that into a failed verification, not a pass.
        runner = DockerRunner({"calc": ["python", "-m", "unittest", "test_calc"]})
        engine = _Engine(repo, verification_runner=runner)
        evil = MutationCandidate(
            "evil", "exfiltrate", "calc.py", "",
            "import socket\n\n"
            "try:\n"
            "    socket.create_connection(('1.1.1.1', 53), timeout=3)\n"
            "    raise SystemExit('EXFIL-REACHED-NETWORK')\n"
            "except OSError:\n"
            "    pass\n"
            "def add(a, b):\n    return a + b\n",
        )
        self.assertTrue(engine.evaluate_mutation_in_sandbox(evil, "calc"), evil.verification_output)
        self.assertNotIn("EXFIL-REACHED-NETWORK", evil.verification_output)


class TestBoundedOutput(unittest.TestCase):
    """The host must never buffer more than the budget, however noisy the candidate is."""

    def test_streaming_overflow_kills_the_process_and_raises_quickly(self):
        flood = "import sys, itertools; [sys.stdout.write(chr(120) * 65536) for _ in itertools.count()]"
        started = time.monotonic()
        with self.assertRaises(OutputLimitExceeded):
            bounded_run([sys.executable, "-c", flood], timeout=30, max_total_bytes=256 * 1024)
        self.assertLess(time.monotonic() - started, 15, "overflow must stop the run, not wait for the timeout")

    def test_output_within_budget_is_returned_intact(self):
        res = bounded_run([sys.executable, "-c", "print('out'); import sys; print('err', file=sys.stderr)"], timeout=30, max_total_bytes=4096)
        self.assertEqual((res.returncode, res.stdout.strip(), res.stderr.strip()), (0, "out", "err"))

    def test_timeout_still_raises_timeout_expired(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            bounded_run([sys.executable, "-c", "import time; time.sleep(60)"], timeout=1, max_total_bytes=4096)

    def test_runner_removes_the_container_and_reraises_on_overflow(self):
        docker = FakeDocker()

        def streamer(cmd, **kw):
            raise OutputLimitExceeded("too much output")

        with tempfile.TemporaryDirectory() as td:
            runner = DockerRunner(PROFILES, runner=docker, docker_bin="docker", streamer=streamer)
            with self.assertRaises(OutputLimitExceeded):
                runner.run(workspace=Path(td).resolve(), profile="unit", timeout=5)
        self.assertIn("rm", docker.verbs())

    def test_engine_rejects_a_candidate_whose_verification_overflows(self):
        with tempfile.TemporaryDirectory() as td:
            repo = _make_repo(td)
            engine = _Engine(repo, verification_runner=FakeRunner(raises=OutputLimitExceeded("flood")))
            cand = MutationCandidate("flood", "d", "src/app.py", "", "a = 1" + chr(10) + "b = 99" + chr(10))
            self.assertFalse(engine.evaluate_mutation_in_sandbox(cand, "unit"))
            self.assertIn("output exceeded", cand.verification_output)


if __name__ == "__main__":
    unittest.main()
