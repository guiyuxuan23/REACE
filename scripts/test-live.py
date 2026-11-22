"""Verify the live API using real HTTP, fresh SQLite and independently authenticated restarts."""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

from live import PINS, REPO, STATE, UPSTREAM, server_launch, venv_python, verify_upstream


def await_start(process, base):
    opener = build_opener(ProxyHandler({}))
    deadline = monotonic() + 15
    while monotonic() < deadline and process.poll() is None:
        try:
            with opener.open(base + "/health", timeout=0.5) as response:
                if json.load(response)["meta"]["source"] == "live":
                    return
        except (URLError, TimeoutError):
            sleep(0.1)
    raise RuntimeError("Live API did not start on the isolated port.")


@contextmanager
def service(profile, interpreter, token, log):
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    command, env = server_launch(port, profile, interpreter, token)
    with log.open("wb") as output:
        process = subprocess.Popen(command, cwd=REPO, env=env, stdout=output, stderr=subprocess.STDOUT)
        try:
            await_start(process, base)
            yield base
        except Exception:
            print(log.read_text(encoding="utf-8"), file=sys.stderr)
            raise
        finally:
            if os.name == "nt" and process.poll() is None:
                # A Windows venv executable can be a redirector. Stop the Uvicorn PID it started.
                started = re.search(rb"Started server process \[(\d+)\]", log.read_bytes())
                if started and int(started[1]) != process.pid:
                    try:
                        os.kill(int(started[1]), signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    for _attempt in range(10):
        with socket.socket() as probe:
            probe.settimeout(0.3)
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                break
        sleep(0.1)
    else:
        raise RuntimeError(f"The integration test did not release port {port}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", type=Path, default=venv_python())
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    verify_upstream(json.loads(PINS.read_text(encoding="utf-8"))["files"])
    original_token = secrets.token_urlsafe(32)
    profile = "test-" + secrets.token_hex(8)
    database = UPSTREAM / "data/users" / f"v2-{profile}.sqlite"
    try:
        with TemporaryDirectory(prefix="http-verification-", dir=STATE) as scratch:
            fixture = Path(scratch) / "fixture.json"
            phases = (("initial", original_token), ("restart", original_token), ("different-owner", secrets.token_urlsafe(32)))
            for phase, token in phases:
                with service(profile, args.python.absolute(), token, Path(scratch) / "server.log") as base:
                    child_env = {**os.environ, "TRACE_TEST_BASE": base, "TRACE_TEST_TOKEN": token,
                                 "TRACE_TEST_PHASE": phase, "TRACE_TEST_FIXTURE": str(fixture)}
                    subprocess.run([args.node, "--test", "tests/live/api.test.mjs"],
                                   cwd=REPO, env=child_env, check=True)
    finally:
        # This randomly named database belongs only to this test.
        for suffix in ("", "-journal", "-wal", "-shm"):
            database.with_name(database.name + suffix).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
