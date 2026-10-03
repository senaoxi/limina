"""Record a command's stdout/stderr in a real POSIX terminal using Python 3."""

import argparse
import codecs
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import termios
import time
from pathlib import Path


def capture(command, directory, columns, rows, timeout):
    started = time.monotonic()
    decoder = codecs.getincrementaldecoder("utf-8")()
    chunks = []
    pid, descriptor = pty.fork()
    if pid == 0:
        os.chdir(directory)
        fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.execvp(command[0], command)
    try:
        while True:
            if time.monotonic() - started > timeout:
                raise TimeoutError(f"Terminal capture exceeded {timeout} seconds")
            ready, _, _ = select.select([descriptor], [], [], 0.1)
            if not ready:
                continue
            try:
                data = os.read(descriptor, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            chunks.append(
                {
                    "atMs": round((time.monotonic() - started) * 1000),
                    "text": decoder.decode(data),
                }
            )
        tail = decoder.decode(b"", final=True)
        if tail:
            chunks.append(
                {"atMs": round((time.monotonic() - started) * 1000), "text": tail}
            )
        _, status = os.waitpid(pid, 0)
        return {"exitCode": os.waitstatus_to_exitcode(status), "chunks": chunks}
    except BaseException:
        # pty.fork creates a new session; stop nested command processes as well.
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        raise
    finally:
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--columns", type=int, default=100)
    parser.add_argument("--rows", type=int, default=80)
    parser.add_argument("--timeout", type=int, default=50)
    parser.add_argument("directory")
    parser.add_argument("output")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command or args.columns < 1 or args.rows < 1:
        parser.error("A command and positive terminal dimensions are required")
    result = capture(command, args.directory, args.columns, args.rows, args.timeout)
    Path(args.output).write_text(
        json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
