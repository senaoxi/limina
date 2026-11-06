import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const compareNames = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const base = import.meta.dirname;
export const root = path.resolve(base, '../..');
export const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const tool = json(path.join(base, 'toolchain.json'));
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const suites = {
  pilot: ['receipt', 'epoch'],
  admission: ['admission'],
  cache: ['cache', 'publication'],
  phase1: ['receipt', 'epoch', 'admission', 'cache', 'publication'],
  'graph-ownership': ['projection', 'ownership'],
};
suites.all = [...suites.phase1, ...suites['graph-ownership']];
suites.stable = suites.all;
const read = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
export function check(ok, message) {
  if (!ok) throw new Error(message);
}

// Deliberately small CFG grammar. Unknown clauses (including state pruning or
// disabled deadlock checks) require a reviewed runner change.
export function config(text) {
  const m =
    /^SPECIFICATION Spec\nCONSTANTS\n((?:\s*\w+ = (?:"[\w-]+"|\d+|TRUE|FALSE)\n)+)INVARIANTS ([\w ]+)\n?$/.exec(
      text,
    );
  check(m, 'Unsupported TLC configuration');
  const invariants = m[2].trim().split(/ +/);
  check(new Set(invariants).size === invariants.length, 'Duplicate invariant');
  return {
    constants: Object.fromEntries(
      m[1]
        .trim()
        .split('\n')
        .map((line) => line.trim().split(' = ')),
    ),
    invariants,
  };
}

// Validate the small declaration convention used by this safety suite. TLC,
// rather than this catalog, parses/evaluates the actual TLA+ specification.
function checkScope(name, spec, map) {
  check(
    map.liveness.startsWith('None:') && map.fairness.startsWith('None;'),
    `${name}: temporal properties require a temporal checker and reporting support`,
  );
  const declarations = /^VARIABLES ([^\n]+(?:\n[ \t]+[\w, ]+)*)/m.exec(spec);
  const variables = declarations?.[1].split(',').map((v) => v.trim());
  const mapped = Object.keys(map.stateVariables).flatMap((group) =>
    group.split(',').map((v) => v.trim()),
  );
  check(
    variables?.toSorted(compareNames).join(',') ===
      mapped.toSorted(compareNames).join(','),
    `${name}: unmapped state variable`,
  );
}
export function catalog({ inspectHashes = false } = {}) {
  const directories = readdirSync(path.join(base, 'models'), {
    withFileTypes: true,
  })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  check(
    directories.toSorted(compareNames).join(',') ===
      suites.all.toSorted(compareNames).join(','),
    'Unexpected or missing model directory',
  );
  return directories.map((domain) => {
    const directory = path.join(base, 'models', domain);
    const maps = readdirSync(directory).filter((n) =>
      n.endsWith('.model.json'),
    );
    check(maps.length === 1, `Expected one contract in ${domain}`);
    const map = json(path.join(directory, maps[0]));
    const name = maps[0].split('.', 1)[0];
    for (const key of [
      'scope',
      'sourceMapping',
      'stateVariables',
      'initialState',
      'actions',
      'assumptions',
      'safety',
      'liveness',
      'fairness',
      'profiles',
      'bounds',
      'counterexamples',
      'empiricalVerification',
      'driftReview',
    ]) {
      check(
        map[key] && Object.keys(map[key]).length > 0,
        `Missing ${name}.${key}`,
      );
    }
    const spec = read(path.join(directory, `${name}.tla`));
    checkScope(name, spec, map);
    const files = readdirSync(path.join(directory, 'profiles')).toSorted(
      compareNames,
    );
    check(
      files.length > 0 &&
        files.join(',') ===
          Object.keys(map.profiles).toSorted(compareNames).join(','),
      `Unmapped profiles in ${name}`,
    );
    const safety = new Set();
    const profiles = files.map((file) => {
      const config_ = read(path.join(directory, 'profiles', file));
      const { invariants, constants } = config(config_);
      const profile = map.profiles[file];
      check(
        typeof profile.stable === 'boolean' &&
          Array.isArray(profile.breaks) &&
          new Set(profile.breaks).size === profile.breaks.length &&
          profile.breaks.every((r) => invariants.includes(r)),
        `${file}: expected rule not enabled`,
      );
      for (const rule of invariants) {
        check(
          Object.hasOwn(map.safety, rule) && spec.includes(`${rule} ==`),
          `${file}: unmapped invariant ${rule}`,
        );
        safety.add(rule);
      }
      return { file, cfg: config_, invariants, constants, ...profile };
    });
    check(
      Object.keys(map.safety).length === safety.size,
      `${name}: safety rule never enabled`,
    );
    check(
      profiles.some((p) => p.stable && p.breaks.length === 0) &&
        profiles.some((p) => p.stable && p.breaks.length > 0),
      `${name}: stable suite needs a positive and a discriminating control`,
    );
    check(
      Number.isSafeInteger(map.bounds.maxStates) && map.bounds.maxStates > 0,
      `${name}: invalid state budget`,
    );
    const mapped = Object.entries(map.sourceMapping);
    for (const [action, binding] of Object.entries(map.actions)) {
      const [owner, symbol] = binding.split('::', 2);
      check(
        spec.match(new RegExp(String.raw`^${action}(?:\(| ==)`, 'm')) &&
          Object.hasOwn(map.sourceMapping, owner) &&
          symbol &&
          read(path.join(root, owner)).includes(symbol),
        `${name}: unmapped action ${action}`,
      );
    }
    const bindings = mapped.map(([file, anchor]) => {
      const content = read(path.join(root, file));
      check(
        content.includes(anchor),
        `needs-review: missing ${file} anchor ${anchor}`,
      );
      return [file, sha(content)];
    });
    const sourceHash = sha(
      JSON.stringify(
        bindings.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    );
    const modelHash = sha(
      JSON.stringify([sha(spec), ...profiles.map((p) => [p.file, sha(p.cfg)])]),
    );
    if (!inspectHashes)
      check(
        sourceHash === map.driftReview.sourceHash &&
          modelHash === map.driftReview.modelHash,
        `needs-review: ${
          name
        } source, witness or model changed; replay before updating its review stamp`,
      );
    check(
      /^[a-f0-9]{40}$/.test(map.driftReview.baseline),
      'Invalid reviewed revision',
    );
    return {
      domain,
      directory,
      name,
      spec,
      profiles,
      map,
      sourceHash,
      modelHash,
    };
  });
}
