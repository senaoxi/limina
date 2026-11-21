#!/usr/bin/env python3
"""Compare two built Limina checkouts in fresh CLI processes and private workspaces."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import shutil
import signal
from statistics import median
import subprocess
import tempfile
import time
import threading


ARMS = ("old-off", "new-off", "new-on")
CASES = ("cold", "warm", "changed", "framework", "concurrent")


def json_file(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def code_identity(repo, entry):
    package = repo / "packages/limina"
    roots = [package / "dist"] if entry == "dist" else [package / "src", package / "bin"]
    files = [package / "package.json", repo / "pnpm-lock.yaml"]
    for root in roots:
        files.extend(p for p in root.rglob("*") if p.is_file())
    h = hashlib.sha256()
    for path in sorted(files):
        h.update(path.relative_to(repo).as_posix().encode() + b"\0" + digest(path).encode())
    return h.hexdigest()


def seed(work, case, modules):
    work.mkdir()
    framework = case == "framework"
    checker = "vue-tsc" if framework else "tsc"
    deps = {}
    targets = ["typescript", "vue", "vue-tsc"] if framework else ["typescript"]
    for name in targets:
        source = (modules / name).resolve(strict=True)
        target = work / "node_modules" / name
        target.parent.mkdir(exist_ok=True)
        target.symlink_to(source, target_is_directory=True)
        deps[name] = json.loads((source / "package.json").read_bytes())["version"]
    package = {
        "name": "profile-benchmark",
        "private": True,
        "type": "module",
        "packageManager": "npm@11.6.1",
        "devDependencies": deps,
    }
    json_file(work / "package.json", package)
    json_file(work / "package-lock.json", {"lockfileVersion": 3, "packages": {"": package}})
    config = {
        "scope": {"checkers": {checker: {"include": ["tsconfig.json"]}}},
        "pipelines": {"probe": ["graph:prepare", "graph:check"]},
    }
    if case == "concurrent":
        config["scope"]["source"] = {"include": ["a/src/**/*.ts", "b/src/**/*.ts"]}
        config["concurrency"] = {"tasks": 4}
        binary_root = work / "node_modules/.bin"
        binary_root.mkdir()
        if os.name == "nt":
            (binary_root / "tsc.cmd").write_text('@node "%~dp0..\\typescript\\bin\\tsc" %*\r\n')
        else:
            (binary_root / "tsc").symlink_to((modules / "typescript/bin/tsc").resolve())
    (work / "limina.config.mjs").write_text("export default " + json.dumps(config) + ";\n")
    project = {
        "compilerOptions": {
            "composite": True,
            "declaration": True,
            "types": [],
            "noLib": True,
            "module": "NodeNext",
            "outDir": "dist",
        },
        "include": ["src/**/*"],
    }
    if case == "concurrent":
        del project["compilerOptions"]["noLib"]
        project["compilerOptions"].update(lib=["es5"], skipDefaultLibCheck=True)
    if framework:
        json_file(work / "tsconfig.json", project)
        (work / "src").mkdir()
        (work / "src/lib.ts").write_text("export const value = 1;\n")
        (work / "src/App.vue").write_text(
            '<script setup lang="ts">import { value } from "./lib.js"</script>\n<template>{{ value }}</template>\n'
        )
    else:
        json_file(
            work / "tsconfig.json", {"files": [], "references": [{"path": "./a"}, {"path": "./b"}]}
        )
        for leaf in ("a", "b"):
            (work / leaf / "src").mkdir(parents=True)
            json_file(work / leaf / "tsconfig.json", project)
        (work / "a/src/main.ts").write_text("export { value } from '../../b/src/main.js';\n")
        (work / "b/src/main.ts").write_text("export const value = 1;\n")


def terminate_tree(proc):
    if os.name == "posix":
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)


def process(node, cli, work, case, profile, log):
    env = {k: v for k, v in os.environ.items() if not k.startswith("LIMINA_PROFILE")}
    env["NODE_OPTIONS"] = ""
    env["NO_COLOR"] = "1"
    env.pop("FORCE_COLOR", None)
    args = [node, str(cli), "check"]
    if case != "concurrent":
        args.append("probe")
    if profile:
        args.append("--profile")
    with log.open("wb") as out:
        start = time.monotonic_ns()
        proc = subprocess.Popen(
            args,
            cwd=work,
            stdout=out,
            stderr=subprocess.STDOUT,
            env=env,
            start_new_session=os.name == "posix",
        )
        alarm = threading.Timer(120, terminate_tree, args=(proc,))
        alarm.start()
        try:
            if hasattr(os, "wait4"):
                _, status, usage = os.wait4(proc.pid, 0)
                proc.returncode = os.waitstatus_to_exitcode(status)
            else:
                proc.wait()
                usage = None
            end = time.monotonic_ns()
        finally:
            alarm.cancel()
    return {
        "startNs": start,
        "endNs": end,
        "exit": proc.returncode,
        "elapsedMs": (end - start) / 1e6,
        "cpuMs": (usage.ru_utime + usage.ru_stime) * 1000 if usage else None,
        "maxRssBytes": (
            usage.ru_maxrss * (1 if platform.system() == "Darwin" else 1024)
            if usage and platform.system() in ("Darwin", "Linux")
            else None
        ),
    }


def checked_work(work, case):
    check = json.loads((work / ".limina/check/last-run.json").read_bytes())
    tasks = [
        (t["label"], t["state"], t.get("checksPassed"), t.get("checksTotal"))
        for t in check["run"]["tasks"]
    ]
    if not any(
        t[0] == "graph:check" and t[1] == "passed" and t[2] == t[3] and (t[3] or 0) > 0
        for t in tasks
    ):
        raise ValueError("graph:check did not pass any checks")
    if case == "concurrent":
        bounds = {
            t["label"]: (t["startedAt"], t["completedAt"])
            for t in check["run"]["tasks"]
            if t["label"] in ("graph:check", "proof:check") and t["state"] == "passed"
        }
        if len(bounds) != 2:
            raise ValueError("concurrent graph/proof tasks did not pass")
        intervals = [
            [datetime.fromisoformat(x.replace("Z", "+00:00")) for x in times]
            for times in bounds.values()
        ]
        if max(t[0] for t in intervals) >= min(t[1] for t in intervals):
            raise ValueError("scheduler did not overlap the graph and proof tasks")
    output_root = work / ".limina/tsconfig"
    output = sorted(output_root.rglob("*.json"))
    if (work / "a/tsconfig.json").is_file():
        project = output_root / "checkers/tsc/projects/a/tsconfig.dts.json"
        references = json.loads(project.read_bytes()).get("references", [])
        if not any(ref["path"] == "../b/tsconfig.dts.json" for ref in references):
            raise ValueError("the generated graph lost the a -> b reference")
    if not output or not list((work / ".limina").rglob("index.liminainfo")):
        raise ValueError("missing generated graph or analysis snapshot")
    return {
        "tasks": tasks,
        "graphFiles": {p.relative_to(work).as_posix(): digest(p) for p in output},
    }


def prepare_sample(folder, cli, node, case, modules):
    folder.mkdir()
    work = folder / "workspace"
    seed(work, case, modules)
    if case != "cold":
        prep = process(node, cli, work, case, False, folder / "seed.log")
        if prep["exit"]:
            raise ValueError("seed failed")
        checked_work(work, case)
        if case == "changed":
            path = work / "b/tsconfig.json"
            config = json.loads(path.read_bytes())
            config["compilerOptions"]["strict"] = True
            json_file(path, config)
        if case == "framework":
            path = work / "src/App.vue"
            path.write_text(path.read_text().replace("{{ value }}", "{{ value + 1 }}"))


def measure_sample(folder, cli, node, case, arm):
    work = folder / "workspace"
    profile = arm == "new-on"
    child = process(node, cli, work, case, profile, folder / "child.log")
    if child["exit"] or "[pass] graph check" not in (folder / "child.log").read_text(
        errors="replace"
    ):
        raise ValueError(f"check failed: {child}")
    result = checked_work(work, case)
    paths = sorted((work / ".limina/profiles").glob("*.json"))
    if len(paths) != int(profile):
        raise ValueError(f"observed {len(paths)} profiles; expected {int(profile)}")
    profile_evidence = []
    for path in paths:
        data = json.loads(path.read_bytes())
        if data.get("schemaVersion") != 2 or not data.get("projects") or not data.get("graphs"):
            raise ValueError(f"incomplete profile: {path.name}")
        expected_source = "restored" if case in ("warm", "concurrent") else "computed"
        if not any(
            g.get("purpose") == "complete" and g.get("source") == expected_source
            for g in data["graphs"]
        ):
            raise ValueError(f"{case} did not observe a {expected_source} complete graph")
        if case == "framework" and not any(
            event["op"] == "vue-program-create" and event["end"] in ("performed", "computed")
            for event in data["work"]
        ):
            raise ValueError("framework revalidation did not perform a Vue Program operation")
        profile_evidence.append(
            {
                "id": data["invocation"]["id"],
                "mode": data["summary"]["mode"],
                "commandUs": data["invocation"]["commandInvocationUs"],
                "firstPrepared": data["summary"]["firstCompleteGraphPrepared"],
                "firstReceiptUs": data["summary"]["firstCompleteReceiptCommittedUs"],
                "projects": len(data["projects"]),
                "graphs": [
                    {"purpose": g.get("purpose"), "source": g.get("source")} for g in data["graphs"]
                ],
            }
        )
    return {
        "elapsedMs": child["elapsedMs"],
        "process": child,
        "work": result,
        "profileEvidence": profile_evidence,
        "profileBytes": sum(p.stat().st_size for p in paths),
    }


def describe(values):
    return {
        "median": median(values),
        "min": min(values),
        "max": max(values),
        "p95": sorted(values)[math.ceil(0.95 * len(values)) - 1],
    }


def compare(pairs, numerator, denominator, budget):
    ratios = [100 * (p[numerator]["elapsedMs"] / p[denominator]["elapsedMs"] - 1) for p in pairs]

    # Resample entire pairs to retain the shared host/time conditions of comparison.
    def median_change(sample):
        after = median(p[numerator]["elapsedMs"] for p in sample)
        before = median(p[denominator]["elapsedMs"] for p in sample)
        return 100 * (after / before - 1)

    n = len(pairs)
    lo, hi = None, None
    verdict = "inconclusive"
    if n >= 10:
        rng = random.Random(2917)
        distribution = sorted(median_change(rng.choices(pairs, k=n)) for _ in range(10_000))
        lo, hi = distribution[249], distribution[9749]
        if hi <= budget:
            verdict = "within-budget"
        elif lo > budget:
            verdict = "over-budget"
    return {
        "ratioOfMediansPercent": median_change(pairs),
        "pairedChangePercent": describe(ratios),
        "ratioOfMediansPairedBootstrap95": [lo, hi],
        "budgetPercent": budget,
        "verdict": verdict,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", required=True, type=Path, help="built baseline checkout")
    parser.add_argument("--candidate", required=True, type=Path, help="built candidate checkout")
    parser.add_argument(
        "--output", required=True, type=Path, help="parent for a new disposable run"
    )
    parser.add_argument("--entry", choices=("dist", "source"), default="dist")
    parser.add_argument("--cases", nargs="+", choices=CASES, default=CASES)
    parser.add_argument("--pairs", type=int, default=10)
    parser.add_argument("--seed", type=int, default=1709)
    parser.add_argument(
        "--setup-workers",
        type=int,
        choices=(1, 2, 3),
        default=2,
        help="maximum simultaneous untimed fixture preparation processes",
    )
    opts = parser.parse_args()
    if len(set(opts.cases)) != len(opts.cases):
        parser.error("duplicate cases")
    if opts.pairs < 1:
        parser.error("--pairs must be positive")
    baseline, candidate = opts.baseline.resolve(), opts.candidate.resolve()
    node = shutil.which("node")
    if not node:
        parser.error("node is missing")
    rel = "packages/limina/" + ("dist/bin/limina.js" if opts.entry == "dist" else "bin/limina.js")
    clis = [(repo / rel).resolve(strict=True) for repo in (baseline, candidate)]
    modules = baseline / "packages/limina/node_modules"
    for repo in (baseline, candidate):
        if opts.output.resolve().is_relative_to(repo):
            parser.error("--output must be outside both measured checkouts")
    opts.output.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix=opts.entry + "-", dir=opts.output)).resolve()
    print(run, flush=True)
    args = vars(opts) | {"baseline": str(baseline), "candidate": str(candidate), "output": str(run)}
    identity = [code_identity(repo, opts.entry) for repo in (baseline, candidate)]
    json_file(
        run / "environment.json",
        {
            "args": args,
            "codeHashes": identity,
            "harnessHash": digest(Path(__file__)),
            "fixtureTools": {
                name: json.loads((modules / name / "package.json").read_bytes())["version"]
                for name in ("typescript", "vue", "vue-tsc")
            },
            "metrics": {
                "elapsedMs": "parent monotonic immediately before spawn through child exit",
                "cpuMs": "wait4 child user + system time (OS accounting)",
                "maxRssBytes": "wait4 child high-water RSS, not concurrent process-tree sum",
                "budget": "ratio of medians; 10,000 paired bootstrap replicates; percentile 95% interval",
            },
            "node": node,
            "version": subprocess.check_output([node, "-v"], text=True).strip(),
            "platform": platform.platform(),
            "cpus": os.cpu_count(),
            "load": os.getloadavg() if hasattr(os, "getloadavg") else None,
        },
    )
    rng = random.Random(opts.seed)
    collected = {case: [] for case in opts.cases}
    for number in range(opts.pairs):
        cases = list(opts.cases)
        rng.shuffle(cases)
        for case in cases:
            arms = list(ARMS)
            rng.shuffle(arms)
            pair = {}
            runtimes = {arm: clis[0 if arm == "old-off" else 1] for arm in arms}
            folders = {arm: run / f"{number:03d}-{case}-{arm}" for arm in arms}
            # All preparation processes have finished before starting the outer clock.
            # Each arm still owns a fresh, independently seeded cache at its final path.
            with ThreadPoolExecutor(max_workers=opts.setup_workers) as executor:
                preparation = {
                    arm: executor.submit(
                        prepare_sample, folders[arm], runtimes[arm], node, case, modules
                    )
                    for arm in arms
                }
                for arm in arms:
                    try:
                        preparation[arm].result()
                    except Exception as exc:
                        json_file(
                            run / "failure.json",
                            {"sample": folders[arm].name, "stage": "setup", "error": str(exc)},
                        )
                        raise
            for arm in arms:
                try:
                    pair[arm] = measure_sample(folders[arm], runtimes[arm], node, case, arm)
                    json_file(folders[arm] / "sample.json", pair[arm])
                except Exception as exc:
                    json_file(
                        run / "failure.json",
                        {"sample": folders[arm].name, "stage": "measurement", "error": str(exc)},
                    )
                    raise
            if any(pair[arm]["work"] != pair["old-off"]["work"] for arm in ARMS):
                raise ValueError(f"{case} pair {number}: graph files or checks differ")
            collected[case].append(pair)
            print(f"{case} {number + 1}/{opts.pairs}", flush=True)
    if [code_identity(repo, opts.entry) for repo in (baseline, candidate)] != identity:
        raise ValueError("runtime changed during measurement")
    summary = {}
    for case, pairs in collected.items():
        summary[case] = {
            "count": len(pairs),
            "externalMs": {arm: describe([p[arm]["elapsedMs"] for p in pairs]) for arm in ARMS},
            "processResources": {
                arm: {
                    metric: describe([p[arm]["process"][metric] for p in pairs])
                    for metric in ("cpuMs", "maxRssBytes")
                    if pairs[0][arm]["process"][metric] is not None
                }
                for arm in ARMS
            },
            "oldOffToNewOff": compare(pairs, "new-off", "old-off", 1),
            "newOffToNewOn": compare(pairs, "new-on", "new-off", 5),
            "profileBytes": describe([p["new-on"]["profileBytes"] for p in pairs]),
        }
    json_file(run / "summary.json", summary)


if __name__ == "__main__":
    main()
