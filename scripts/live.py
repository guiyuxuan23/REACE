"""Prepare a pinned V1 backend copy and run the loopback-only V2 integration."""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
import venv
from zipfile import BadZipFile, ZipFile


REPO = Path(__file__).resolve().parents[1]
STATE = REPO / ".trace-live"
UPSTREAM = STATE / "AccessibleBeautyAgent"
ENV = STATE / "venv"
PINS = REPO / "backend/live/upstream-files.json"
DEPENDENCIES = "backend/requirements-runtime.txt"
BASELINE_ARCHIVE = REPO / "support/trace-v1-backend.zip"


def override_safe(path):
    if path.absolute() != path.resolve():
        raise ValueError(f"Live runtime must use a regular path inside the workspace: {path}")


def verify_file(data, pin):
    if len(data) != pin["size"] or sha256(data).hexdigest() != pin["sha256"]:
        raise ValueError(f"V1 baseline mismatch: {pin['path']}")


def verify_upstream(pins):
    for pin in pins:
        path = STATE / pin["path"]
        override_safe(path)
        verify_file(path.read_bytes(), pin)


def pinned_entries(source, pins):
    members = source.infolist()
    for pin in pins:
        name = pin["path"]
        matches = [member for member in members if member.filename == name]
        if len(matches) != 1 or matches[0].file_size != pin["size"]:
            raise ValueError(f"Expected exactly one pinned entry with the original size: {name}")
        data = source.read(matches[0])
        verify_file(data, pin)
        yield name, data


def prepare(archive, pins):
    if UPSTREAM.exists():
        verify_upstream(pins)
        print("Isolated V1 runtime already prepared and verified.")
        return
    with ZipFile(archive) as source, TemporaryDirectory(prefix="prepare-", dir=STATE) as scratch:
        for name, data in pinned_entries(source, pins):
            destination = Path(scratch) / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as output:
                output.write(data)
        (Path(scratch) / UPSTREAM.name).rename(UPSTREAM)
    print(f"Verified {len(pins)} pinned V1 files and prepared an isolated runtime.")


def venv_python():
    return ENV / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def install():
    if not venv_python().exists():
        venv.EnvBuilder(with_pip=True).create(ENV)
    subprocess.run([venv_python(), "-m", "pip", "install", "-r", UPSTREAM / DEPENDENCIES], check=True)
    subprocess.run([venv_python(), "-m", "pip", "check"], check=True)


def server_launch(port, profile, interpreter, token):
    if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token):
        raise ValueError("Set TRACE_LIVE_TOKEN to a fresh token from secrets.token_urlsafe(32).")
    if not (1 <= port <= 65_535 and re.fullmatch(r"[A-Za-z0-9_-]{1,32}", profile)):
        raise ValueError("Invalid port or profile name.")
    db = UPSTREAM / "data/users" / f"v2-{profile}.sqlite"
    override_safe(db)
    env = {key: value for key, value in os.environ.items() if key in {
        "PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
    }}
    env.update({
        "TRACE_LIVE_TOKEN": token, "TRACE_LIVE_PORT": str(port), "TRACE_ENV_FILE": os.devnull,
        "TRACE_LIVE_UPSTREAM": str(UPSTREAM), "TRACE_LIVE_DB": str(db),
        "PYTHONPATH": os.pathsep.join((str(REPO), str(UPSTREAM / "backend"))),
        "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1",
    })
    if not interpreter.is_file():
        raise ValueError("Run scripts/live.py install before starting the API.")
    return [interpreter, "-m", "uvicorn", "backend.live.entrypoint:create_app", "--factory",
            "--host", "127.0.0.1", "--port", str(port), "--workers", "1", "--no-proxy-headers", "--no-access-log"], env


def run(args):
    interpreter = args.python.absolute() if args.python else venv_python()
    command, env = server_launch(args.port, args.profile, interpreter, os.getenv("TRACE_LIVE_TOKEN", ""))
    print(f"TRACE live API on http://127.0.0.1:{args.port} (profile: {args.profile})", flush=True)
    return subprocess.call(command, env=env, cwd=REPO)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("prepare")
    setup.add_argument("--archive", type=Path, default=BASELINE_ARCHIVE)
    commands.add_parser("install")
    serve = commands.add_parser("run")
    serve.add_argument("--port", default=8000, type=int)
    serve.add_argument("--profile", default="local", help="Isolated V2 SQLite profile name")
    serve.add_argument("--python", type=Path, help="Use an existing CPython 3.12 environment with the V1 lock installed")
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 12):
        raise ValueError("Use CPython 3.12 for the pinned upstream requirements.")
    pins = json.loads(PINS.read_text(encoding="utf-8"))["files"]
    override_safe(STATE)
    override_safe(ENV)
    if os.name != "nt":
        os.umask(0o077)
    STATE.mkdir(exist_ok=True)
    if args.command == "prepare":
        prepare(args.archive, pins)
    else:
        verify_upstream(pins)
        if args.command == "install":
            install()
        else:
            return run(args)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, ValueError, BadZipFile, subprocess.CalledProcessError) as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
