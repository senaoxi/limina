import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process, { env } from 'node:process';
import { parseArgs } from 'node:util';
import {
  base,
  catalog,
  check,
  compareNames,
  root,
  sha,
  suites,
  tool,
} from './catalog.mjs';

function verifyProfile(model, profile, out, jar) {
  const directory = path.join(
    out,
    `${model.name}-${profile.file.slice(0, -4)}`,
  );
  mkdirSync(directory);
  writeFileSync(path.join(directory, `${model.name}.tla`), model.spec);
  writeFileSync(path.join(directory, profile.file), profile.cfg);
  const start = Date.now();
  const rules = Object.fromEntries(
    [...profile.invariants, 'NoDeadlock'].map((r) => [r, 'unchecked']),
  );
  const result = {
    domain: model.domain,
    profile: profile.file,
    expected: profile.breaks,
    constants: profile.constants,
    notConfigured: Object.keys(model.map.safety).filter(
      (r) => !profile.invariants.includes(r),
    ),
    baseline: model.map.driftReview.baseline,
    sourceHash: model.sourceHash,
    modelHash: model.modelHash,
    configHash: sha(profile.cfg),
    rules,
    attempts: [],
    status: 'incomplete',
  };
  let remaining = [...profile.invariants];
  try {
    for (let index = 0; index <= profile.invariants.length; index++) {
      const log = index ? `recheck-${index}.out` : 'tlc.out';
      const config = index ? `recheck-${index}.cfg` : profile.file;
      if (index) {
        const clause =
          remaining.length > 0 ? `INVARIANTS ${remaining.join(' ')}` : '';
        writeFileSync(
          path.join(directory, config),
          profile.cfg.replace(/^INVARIANTS .+$/m, () => clause),
        );
      }
      const arguments_ = [
        '-Xmx1g',
        '-XX:+UseParallelGC',
        `-Djava.io.tmpdir=${directory}`,
        '-cp',
        jar,
        'tlc2.TLC',
        '-workers',
        '1',
        '-fp',
        '0',
        '-metadir',
        `states-${index}`,
        '-config',
        config,
        `${model.name}.tla`,
      ];
      const fd = openSync(path.join(directory, log), 'wx');
      const left = tool.timeoutMs - (Date.now() - start);
      let proc;
      try {
        check(left > 0, 'profile timeout');
        proc = spawnSync('java', arguments_, {
          cwd: directory,
          stdio: ['ignore', fd, fd],
          timeout: left,
          killSignal: 'SIGKILL',
          env: { ...env, LC_ALL: 'C' },
        });
      } finally {
        closeSync(fd);
      }
      const raw = readFileSync(path.join(directory, log), 'utf8');
      const initial = Number(
        /Finished computing initial states: (\d+) distinct states? generated/.exec(
          raw,
        )?.[1],
      );
      const stats =
        /([\d,]+) states? generated, ([\d,]+) distinct states? found, ([\d,]+) states? left on queue/.exec(
          raw,
        );
      const [generated, distinct, queue] = stats
        ? stats.slice(1).map((n) => Number(n.replaceAll(',', '')))
        : [];
      const broken = /^Error: Invariant (\w+) is violated\./m.exec(raw)?.[1];
      result.attempts.push({
        log,
        args: arguments_.map((x) => (x === jar ? '$TLA2TOOLS' : x)),
        initial,
        generated,
        distinct,
        queue,
        exit: proc.status,
        signal: proc.signal,
        broken,
      });
      check(
        !proc.error && !proc.signal,
        proc.error?.message ?? 'interrupted TLC',
      );
      check(
        initial > 0 && distinct > 0 && distinct <= model.map.bounds.maxStates,
        'empty, truncated or over-budget search',
      );
      if (
        proc.status === 12 &&
        remaining.includes(broken) &&
        /^State \d+:/m.test(raw)
      ) {
        rules[broken] = 'breaks';
        remaining = remaining.filter((r) => r !== broken);
        continue;
      }
      if (/^Error: Deadlock reached\./m.test(raw)) rules.NoDeadlock = 'breaks';
      check(
        proc.status === 0 &&
          queue === 0 &&
          raw.includes('Model checking completed. No error has been found.'),
        'TLC did not exhaust the search',
      );
      for (const rule of [...remaining, 'NoDeadlock']) rules[rule] = 'holds';
      const found = Object.keys(rules)
        .filter((r) => rules[r] === 'breaks')
        .toSorted(compareNames);
      result.status =
        found.join(',') === profile.breaks.toSorted(compareNames).join(',')
          ? 'matched'
          : 'unexpected';
      break;
    }
  } catch (error) {
    result.reason = error.message;
  }
  result.ms = Date.now() - start;
  return result;
}

function main() {
  const { values } = parseArgs({
    options: {
      'review-hashes': { type: 'boolean' },
      profile: { type: 'string' },
      'check-map': { type: 'boolean' },
      suite: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const models = catalog({ inspectHashes: values['review-hashes'] });
  if (values['review-hashes']) {
    check(
      !values['check-map'] && !values.suite && !values.out && !values.profile,
      '--review-hashes is standalone',
    );
    process.stdout.write(
      JSON.stringify(
        models.map(({ name, sourceHash, modelHash }) => ({
          name,
          sourceHash,
          modelHash,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (values['check-map']) {
    check(
      !values.suite && !values.out && !values.profile,
      '--check-map takes no suite or output directory',
    );
    process.stdout.write(
      `Reviewed maps: ${models.map((m) => m.name).join(', ')}\n`,
    );
    return;
  }
  check(
    Object.hasOwn(suites, values.suite) && values.out,
    'Use --check-map or --suite pilot|admission|cache|phase1|graph-ownership|stable|all --out NEW_DIRECTORY',
  );
  const out = path.resolve(values.out);
  mkdirSync(out); // refuse even an empty existing directory: never replace evidence
  const report = {
    suite: values.suite,
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tool: tool.version,
    verifier: Object.fromEntries(
      ['run.mjs', 'catalog.mjs', 'toolchain.json'].map((file) => [
        file,
        sha(readFileSync(path.join(base, file))),
      ]),
    ),
    profiles: [],
    complete: false,
  };
  let toolDirectory;
  try {
    report.head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const sourceJar = path.resolve(
      env.TLA2TOOLS ??
        path.join(
          homedir(),
          '.cache',
          'pstack-statechart',
          `tla2tools-${tool.version}.jar`,
        ),
    );
    const bytes = readFileSync(sourceJar);
    report.jarHash = sha(bytes);
    check(report.jarHash === tool.sha256, 'TLC SHA-256 mismatch');
    // The release manifest also names a sibling CommunityModules.jar. Execute
    // only the verified bytes, without inheriting the source directory's jars.
    toolDirectory = mkdtempSync(path.join(tmpdir(), 'limina-formal-tool-'));
    const jar = path.join(toolDirectory, 'tla2tools.jar');
    writeFileSync(jar, bytes, { flag: 'wx', mode: 0o600 });
    const java = spawnSync('java', ['-version'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    check(java.status === 0, 'Java unavailable');
    report.java = (java.stderr + java.stdout).trim();
    for (const model of models) {
      if (!suites[values.suite].includes(model.domain)) continue;
      writeFileSync(
        path.join(out, `${model.name}.model.json`),
        `${JSON.stringify(model.map, null, 2)}\n`,
      );
      for (const p of model.profiles) {
        if (
          (values.suite === 'stable' && !p.stable) ||
          (values.profile && values.profile !== `${model.domain}/${p.file}`)
        )
          continue;
        const result = verifyProfile(model, p, out, jar);
        report.profiles.push(result);
        process.stdout.write(
          `${[result.status, model.name, p.file, result.reason]
            .filter(Boolean)
            .join(' ')}\n`,
        );
        writeFileSync(
          path.join(out, 'run.json'),
          `${JSON.stringify(report, null, 2)}\n`,
        );
      }
    }
    report.complete =
      report.profiles.length > 0 &&
      report.profiles.every((p) => p.status === 'matched');
    check(
      report.complete,
      `unexpected verdict or incomplete search; see ${path.join(out, 'run.json')}`,
    );
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    if (toolDirectory) rmSync(toolDirectory, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    writeFileSync(
      path.join(out, 'run.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
}
try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
