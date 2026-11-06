import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process, { env } from 'node:process';
import { base, catalog, json, root } from '../../catalog.mjs';

// Change expected outcomes and budgets only in the caller's evidence copy.
// Use the actual locked JVM checker; this is an independent oracle for the runner.
assert.ok(process.argv[2], 'provide a fresh output directory');
const out = path.resolve(process.argv[2]);
mkdirSync(out);
const isolated = path.join(out, 'copy');
const formal = path.join(isolated, 'verification', 'formal');
mkdirSync(formal, { recursive: true });
for (const file of ['catalog.mjs', 'run.mjs', 'toolchain.json', 'models']) {
  cpSync(path.join(base, file), path.join(formal, file), { recursive: true });
}
const epochFile = 'models/epoch/EpochValidation.model.json';
for (const model of catalog()) {
  for (const file of Object.keys(model.map.sourceMapping)) {
    const destination = path.join(isolated, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(root, file), destination);
  }
}
const git = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const arguments_ = (profile, destination) => [
  '--suite',
  'pilot',
  '--profile',
  profile,
  '--out',
  path.join(out, destination),
];
const record = [];
function run(name, argv, exit, extra = {}) {
  const child = spawnSync(
    process.execPath,
    [path.join(formal, 'run.mjs'), ...argv],
    {
      env: { ...env, GIT_DIR: git, ...extra },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  const log = child.stdout + child.stderr;
  writeFileSync(path.join(out, `${name}.log`), log);
  assert.equal(child.status, exit, log);
  record.push({ name, exit });
  return log;
}
const ordinary = 'epoch/epoch-before-identity.cfg';
const negative = 'epoch/epoch-validation-boundary.cfg';
run('positive', arguments_(ordinary, 'positive'), 0);
assert.match(run('collision', arguments_(ordinary, 'positive'), 1), /EEXIST/);
assert.match(
  run('bad-tool', arguments_(negative, 'bad-tool'), 1, {
    TLA2TOOLS: path.join(formal, epochFile),
  }),
  /SHA-256 mismatch/,
);
const epoch = path.join(formal, epochFile);
const original = readFileSync(epoch, 'utf8');
for (const [profile, expected, name] of [
  [ordinary, ['AcceptedResultUsesActiveEpoch'], 'vanished'],
  [negative, ['TypeOK'], 'wrong-rule'],
]) {
  const edited = JSON.parse(original);
  edited.profiles[path.basename(profile)].breaks = expected;
  writeFileSync(epoch, JSON.stringify(edited));
  run(name, arguments_(profile, name), 1);
  const result = json(path.join(out, name, 'run.json'));
  assert.equal(result.complete, false);
  assert.equal(result.profiles[0].status, 'unexpected');
}
writeFileSync(epoch, original);
run(
  'two-violations',
  arguments_('receipt/mutation-late-receipt.cfg', 'two-violations'),
  0,
);
const [multiple] = json(path.join(out, 'two-violations', 'run.json')).profiles;
assert.deepEqual(multiple.rules, {
  TypeOK: 'holds',
  ReceiptCurrentGeneration: 'breaks',
  NoStaleAdoption: 'breaks',
  OldFailureCannotClearNew: 'holds',
  NoDeadlock: 'holds',
});
const lock = path.join(formal, 'toolchain.json');
writeFileSync(lock, JSON.stringify({ ...json(lock), timeoutMs: 1 }));
run('timeout', arguments_(negative, 'timeout'), 1);
const [timedOut] = json(path.join(out, 'timeout', 'run.json')).profiles;
assert.equal(timedOut.status, 'incomplete');
assert.deepEqual(
  new Set(Object.values(timedOut.rules)),
  new Set(['unchecked']),
);
const upstream = path.join(
  isolated,
  'packages/limina/src/core/build-graph/cached-reference-reconstruction.ts',
);
writeFileSync(
  upstream,
  `${readFileSync(upstream, 'utf8')}\n// independent drift challenge\n`,
);
assert.match(run('drift', ['--check-map'], 1), /needs-review/);
writeFileSync(
  path.join(out, 'observations.json'),
  `${JSON.stringify(record, null, 2)}\n`,
);
