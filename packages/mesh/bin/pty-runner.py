#!/usr/bin/env python3
import os
import pty
import select
import signal
import sys


def main() -> int:
    try:
        separator = sys.argv.index("--")
    except ValueError:
        print("pty-runner: missing -- command separator", file=sys.stderr)
        return 2
    command = sys.argv[separator + 1 :]
    if not command:
        print("pty-runner: missing command", file=sys.stderr)
        return 2

    child_pid, master_fd = pty.fork()
    if child_pid == 0:
        os.execvpe(command[0], command, os.environ)

    def forward_signal(signum, _frame):
        try:
            os.kill(child_pid, signum)
        except ProcessLookupError:
            pass

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, forward_signal)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    stdin_open = True
    try:
        while True:
            readers = [master_fd]
            if stdin_open:
                readers.append(stdin_fd)
            ready, _, _ = select.select(readers, [], [], 0.25)
            if master_fd in ready:
                try:
                    data = os.read(master_fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                os.write(stdout_fd, data)
            if stdin_open and stdin_fd in ready:
                data = os.read(stdin_fd, 65536)
                if not data:
                    stdin_open = False
                else:
                    os.write(master_fd, data)
            done, status = os.waitpid(child_pid, os.WNOHANG)
            if done == child_pid:
                return os.waitstatus_to_exitcode(status)
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    _, status = os.waitpid(child_pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    raise SystemExit(main())
