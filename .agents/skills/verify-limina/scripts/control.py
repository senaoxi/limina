#!/usr/bin/env python3
"""Drive the built Limina CLI in disposable projects; retain proof outside them."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import contextmanager

REPO = Path(__file__).resolve().parents[4]
NODE = shutil.which("node")
ENTRIES = {
    "limina": REPO / "packages/limina/dist/bin/limina.js",
    "migrate": REPO / "packages/migrate/dist/bin/limina-migrate.js",
}


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_identity():
    result = {}
    for name, entry in ENTRIES.items():
        if not entry.is_file():
            raise RuntimeError("Run pnpm run build first: " + str(entry))
        root = entry.parent.parent
        result[name] = {
            str(p.relative_to(root)): digest(p)
            for p in sorted(root.rglob("*"))
            if p.is_file() and p.suffix in (".js", ".json")
        }
    return result


def setup(parent, bare=False):
    identity = build_identity()
    parent = Path(parent).expanduser().resolve()
    if parent == REPO or REPO in parent.parents:
        raise RuntimeError("Use the external evidence workspace, not this checkout")
    parent.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    work = run / "workspace"
    work.mkdir()
    token = str(uuid.uuid4())
    state = {"owner": token, "repo": str(REPO), "node": NODE, "build": identity}
    write_json(run / "owner.json", state)
    (work / ".verify-limina-owner").write_text(token)
    try:
        ts_manifest = Path(subprocess.check_output([
            NODE, "-p", "require.resolve('typescript/package.json')"
        ], cwd=REPO, text=True).strip()).resolve()
        ts_version = read_json(ts_manifest)["version"]
        pm = read_json(REPO / "package.json")["packageManager"]
        write_json(work / "package.json", {
            "name": "verify-limina-example", "private": True, "type": "module",
            "packageManager": pm,
            "devDependencies": {
                "limina": read_json(REPO / "packages/limina/package.json")["version"],
                "typescript": ts_version,
            },
        })
        write_json(work / "tsconfig.json", {
            "compilerOptions": {
                "target": "ES2022", "module": "NodeNext",
                "moduleResolution": "NodeNext", "strict": True, "types": [],
            },
            "include": ["src/**/*.ts"],
        })
        (work / "src").mkdir()
        (work / "src/index.ts").write_text("export const answer: number = 42;\n")
        (work / ".gitignore").write_text("node_modules/\n.limina/\n")
        if not bare:
            (work / "limina.config.mjs").write_text("export default {};\n")
        modules = work / "node_modules"
        (modules / ".bin").mkdir(parents=True)
        (modules / "typescript").symlink_to(ts_manifest.parent, target_is_directory=True)
        (modules / "limina").symlink_to(ENTRIES["limina"].parent.parent, target_is_directory=True)
        (modules / ".bin/tsc").symlink_to(ts_manifest.parent / "bin/tsc")
        state.update({
            "typescript": ts_version, "typescriptPath": str(ts_manifest.parent),
            "packageManager": pm,
            "nodeVersion": subprocess.check_output([NODE, "--version"], text=True).strip(),
            "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
            "platform": sys.platform,
        })
        write_json(run / "owner.json", state)
        snapshot(work, run / "seed")
    except BaseException:
        cleanup(run)
        raise
    print(run)


def owned(run):
    run = Path(run).resolve()
    state = read_json(run / "owner.json")
    if state["repo"] != str(REPO):
        raise RuntimeError("Run belongs to a different checkout")
    work = run / "workspace"
    if work.is_symlink():
        raise RuntimeError("Refusing a linked workspace")
    if work.exists() and (work / ".verify-limina-owner").read_text() != state["owner"]:
        raise RuntimeError("Workspace ownership marker mismatch")
    return run, work, state


@contextmanager
def exclusive(run):
    lock = run / ".busy"
    lock.mkdir()
    try:
        yield
    finally:
        lock.rmdir()


def snapshot(work, destination):
    destination.mkdir()
    inventory = {}
    for directory, dirs, names in os.walk(work, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in ("node_modules", ".git"))
        for name in sorted(dirs + names):
            source = Path(directory) / name
            relative = source.relative_to(work)
            if name == ".verify-limina-owner":
                continue
            if source.is_symlink():
                inventory[str(relative)] = {"symlink": os.readlink(source)}
            elif source.is_file():
                target = destination / "files" / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                inventory[str(relative)] = {"sha256": digest(source)}
    write_json(destination / "inventory.json", inventory)


def doctor(run):
    run, work, state = owned(run)
    if not work.is_dir() or (run / ".busy").exists():
        raise RuntimeError("Workspace missing or another driver holds .busy")
    if state["node"] != NODE or state["build"] != build_identity():
        raise RuntimeError("Node path or built distribution changed; create a fresh run after rebuilding")
    ts = work / "node_modules/typescript/package.json"
    if str(ts.resolve().parent) != state["typescriptPath"] or read_json(ts)["version"] != state["typescript"]:
        raise RuntimeError("TypeScript bridge changed")
    current_node = subprocess.check_output([NODE, "--version"], text=True).strip()
    if current_node != state["nodeVersion"]:
        raise RuntimeError("Node version changed")
    if (work / "node_modules/limina").resolve() != ENTRIES["limina"].parent.parent:
        raise RuntimeError("Limina bridge changed")
    help_text = subprocess.check_output(
        [NODE, str(ENTRIES["limina"]), "--help"], cwd=work, text=True, timeout=20
    )
    if "graph <action>" not in help_text or "check [pipeline]" not in help_text:
        raise RuntimeError("Built CLI help does not expose the expected user commands")
    versions = {"limina": read_json(ENTRIES["limina"].parent.parent / "package.json")["version"]}
    versions["migrate"] = subprocess.check_output(
        [NODE, str(ENTRIES["migrate"]), "--version"], cwd=work, text=True, timeout=20
    ).strip()
    return {"ready": True, "versions": versions, "node": state["nodeVersion"],
            "typescript": state["typescript"],
            "configPresent": any((work / name).is_file() for name in ("limina.config.mts", "limina.config.mjs"))}


def drive(run, label, surface, args):
    if not label or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in label):
        raise ValueError("Use a unique lowercase/digit/hyphen evidence label")
    if surface not in ("limina", "migrate", "query") or not args:
        raise ValueError("Choose limina, migrate, or query and supply CLI arguments")
    if surface == "query" and not (args[0] == "check" and "--issues" in args):
        raise ValueError("Pipe transport is reserved for stored issue queries")
    health = doctor(run)
    run, work, _ = owned(run)
    entry = ENTRIES["limina" if surface == "query" else surface]
    command = [NODE, str(entry), *args]
    with exclusive(run):
        evidence = run / label
        evidence.mkdir()
        write_json(evidence / "action.json", {
            "argv": command, "cwd": str(work), "doctor": health,
            "transport": "pipes" if surface == "query" else "PTY 100x80",
            "terminalEnvironment": {key: os.environ.get(key) for key in ("CI", "TERM", "NO_COLOR", "FORCE_COLOR")},
        })
        snapshot(work, evidence / "before")
        try:
            if surface == "query":
                result = subprocess.run(command, cwd=work, capture_output=True, text=True, timeout=60)
                (evidence / "stdout.txt").write_text(result.stdout)
                (evidence / "stderr.txt").write_text(result.stderr)
                code = result.returncode
            else:
                spec = importlib.util.spec_from_file_location("limina_terminal", REPO / "scripts/docs/capture-terminal.py")
                terminal = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(terminal)
                result = terminal.capture(command, str(work), 100, 80, 60)
                write_json(evidence / "terminal.json", result)
                (evidence / "terminal.txt").write_text("".join(c["text"] for c in result["chunks"]))
                code = result["exitCode"]
            write_json(evidence / "result.json", {"exitCode": code})
        except BaseException as error:
            write_json(evidence / "error.json", {"type": type(error).__name__, "message": str(error)})
            raise
        finally:
            snapshot(work, evidence / "after")
    print(json.dumps({"evidence": str(evidence), "exitCode": code}))
    return code if code >= 0 else 128 - code


def cleanup(run):
    run, work, _ = owned(run)
    with exclusive(run):
        if work.exists():
            # A failed snapshot must leave the inputs available for recovery.
            destination = Path(tempfile.mkdtemp(prefix="cleanup-", dir=run)) / "state"
            snapshot(work, destination)
            shutil.rmtree(work)
        write_json(run / "cleanup.json", {"workspaceRemoved": not work.exists(), "evidenceRetained": True})


def main():
    args = sys.argv[1:]
    if not args:
        raise ValueError("Usage: control.py setup PARENT [--bare] | doctor RUN | drive RUN LABEL {limina|migrate|query} ARGS... | cleanup RUN")
    if args[0] == "setup" and len(args) in (2, 3):
        if len(args) == 3 and args[2] != "--bare":
            raise ValueError("Only --bare is supported")
        setup(args[1], len(args) == 3)
    elif args[0] == "doctor" and len(args) == 2:
        print(json.dumps(doctor(args[1]), indent=2))
    elif args[0] == "cleanup" and len(args) == 2:
        cleanup(args[1])
    elif args[0] == "drive" and len(args) >= 5:
        return drive(args[1], args[2], args[3], args[4:])
    else:
        raise ValueError("Invalid command; run control.py without arguments for usage")
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main())
