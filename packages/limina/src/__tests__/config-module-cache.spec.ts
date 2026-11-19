import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { AnalysisMetricMeasurement } from '../application/analysis/analysis-run';
import { type AnalysisSnapshot } from '../core/analysis-cache/contracts';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { AnalysisCacheStore } from '../preflight/analysis-cache-store';
import { createFixturePathResolver } from './helpers/path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(extension = 'mjs') {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-config-modules-'));
  const root = realpathSync.native(temporary);
  roots.push(root);
  const file = createFixturePathResolver(root);
  let mtime = Math.floor(Date.now() / 1000) + 10;
  const write = (name: string, text: string): void => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), text);
    utimesSync(file(name), ++mtime, mtime);
  };
  write(
    'package.json',
    JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'module',
      packageManager: 'pnpm@11.28.3',
    }),
  );
  writeFileSync(file('pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(
    file('pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
  );
  write('analysis-input', 'unchanged');
  writeFileSync(
    file('tsconfig.json'),
    '{"compilerOptions":{"noLib":true,"types":[]},"files":["analysis-input.ts"]}',
  );
  write('analysis-input.ts', 'export {};');
  write(`limina.config.${extension}`, 'export default {pipelines:{probe:[]}};');
  const url = (name: string) => new URL(`../${name}.ts`, import.meta.url).href;
  const entryURL = pathToFileURL(file(`limina.config.${extension}`)).href;
  write(
    'runner.mjs',
    `
import {loadConfig} from ${JSON.stringify(url('config/loader'))};
import {parseProjectConfigWithExtensions} from ${JSON.stringify(url('checker/project-base'))};
import {AnalysisCacheController} from ${JSON.stringify(url('preflight/analysis-cache'))};
import {AnalysisCacheStore} from ${JSON.stringify(url('preflight/analysis-cache-store'))};
import {createLiminaArtifactNamespace} from ${JSON.stringify(url('domain/artifacts/namespace'))};
import {readFileSync,rmSync,writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
if(process.argv.includes('--transform'))registerHooks({
  load(url,context,next){
    const result=next(url,context);
    if(!url.startsWith(${JSON.stringify(entryURL)}))return result;
    const source=typeof result.source==='string'?result.source:new TextDecoder().decode(result.source);
    return {...result,source:source+'\\nif(false){const target="./never.mjs"; await import(target);}'};
  }
});
const config = await loadConfig({cwd:${JSON.stringify(root)},configLoader:process.argv[2]});
const namespace = createLiminaArtifactNamespace({rootDir:config.rootDir,generation:0});
const events=[];
const controller = new AnalysisCacheController(config,namespace,{force:process.argv.includes('--force'),metrics:{record:event=>events.push(event)}});
const restored=controller.cache.previous!==undefined;
const adoptedInputs=[...new Set(Object.values(controller.cache.inputs.records)
  .filter(input=>input.path!==${JSON.stringify(file('pnpm-lock.yaml'))})
  .map(input=>input.path))];
const analyzedEpochs=[];
let analyses=0;
let error;
try {
  await controller.analyze({analyze:async()=>{
    analyses++;
    if(analyses===1 && process.argv.includes('--remove-lock'))rmSync(${JSON.stringify(file('pnpm-lock.yaml'))});
    if(process.argv.includes('--leaf'))controller.cache.observeProjectLock(${JSON.stringify(file('leaf', 'tsconfig.json'))});
    analyzedEpochs.push(controller.cache.previous!==undefined);
    controller.cache.inputs.observeConfig(parseProjectConfigWithExtensions({configPath:${JSON.stringify(file('tsconfig.json'))},projectRootDir:${JSON.stringify(root)}},[]).configClosure);
    if(process.argv.includes('--drift'))writeFileSync(config.configPath,'export default {}; // changed during invocation');
    if(process.argv.includes('--dependency-drift'))writeFileSync(config.cache.dependencies[0],'changed while analyzing');
  },refresh:()=>controller.refresh()});
  await controller.publish();
}catch(caught){error=caught.message;}
const store=new AnalysisCacheStore({namespace,identity:'path-only',configPath:config.configPath});
let snapshot;
try{snapshot=JSON.parse(readFileSync(store.path,'utf8'));}catch{}
console.log(JSON.stringify({restored,events,snapshot,cachePath:store.path,adoptedInputs,analyses,analyzedEpochs,error}));`,
  );
  const run = (
    loader = 'native',
    arguments_: string[] = [],
    environment: Record<string, string> = {},
  ) => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        file('runner.mjs'),
        loader,
        ...arguments_,
      ],
      { encoding: 'utf8', env: { ...process.env, ...environment } },
    );
    expect(result.status, result.stderr).toBe(0);
    return {
      ...(JSON.parse(result.stdout) as {
        restored: boolean;
        events: AnalysisMetricMeasurement[];
        snapshot: AnalysisSnapshot;
        cachePath: string;
        analyses: number;
        analyzedEpochs: boolean[];
        adoptedInputs: string[];
        error?: string;
      }),
      stderr: result.stderr,
    };
  };
  return { path: file, write, run, root };
}

function count(events: AnalysisMetricMeasurement[], kind: string): number {
  return events
    .filter((event) => event.kind === kind)
    .reduce((total, event) => total + (event.count ?? 0), 0);
}

it('reuses the governing lock hash through its committed time and checkpoints a byte-identical touch', () => {
  const f = fixture();
  const cold = f.run();
  expect(cold.error).toBeUndefined();
  expect(cold.restored).toBe(false);
  expect(count(cold.events, 'lockHashes')).toBe(1);
  const warm = f.run();
  expect(warm.restored).toBe(true);
  expect(count(warm.events, 'lockHashes')).toBe(0);
  const lock = f.path('pnpm-lock.yaml');
  const now = new Date();
  utimesSync(lock, now, now);
  const touched = f.run();
  expect(touched.error, JSON.stringify(touched.events)).toBeUndefined();
  expect(touched.restored).toBe(true);
  expect(count(touched.events, 'lockHashes')).toBe(1);
  expect(touched.snapshot.header.revision).not.toBe(
    cold.snapshot.header.revision,
  );
  expect(touched.snapshot.header.baselineTime).toBeGreaterThanOrEqual(
    statSync(lock).mtimeMs,
  );
  expect(count(f.run().events, 'lockHashes')).toBe(0);
});

it.each(['changed', 'opaque', 'missing'])(
  'rejects a %s governing lock before reading any fact block',
  (fault) => {
    const f = fixture();
    const cold = f.run();
    expect(cold.error).toBeUndefined();
    expect(f.run().restored).toBe(true);
    const lock = f.path('pnpm-lock.yaml');
    if (fault === 'missing') rmSync(lock);
    else
      writeFileSync(
        lock,
        fault === 'opaque'
          ? Buffer.from([0xff, 0, 0, 0x80])
          : "lockfileVersion: '9.0'\nimporters:\n  .: {}\n# changed\n",
      );
    const result = f.run();
    expect(result.error).toBeUndefined();
    expect(result.restored).toBe(false);
    expect(count(result.events, 'read-block')).toBe(0);
    expect(result.adoptedInputs).toEqual([]);
    expect(f.run().restored).toBe(fault !== 'missing');
  },
);

it('discards an admitted epoch when its lock disappears before analysis completes', () => {
  const f = fixture();
  expect(f.run().error).toBeUndefined();
  const removed = f.run('native', ['--remove-lock']);
  expect(removed.error).toBeUndefined();
  expect(removed.analyzedEpochs).toEqual([true, false]);
  expect(count(removed.events, 'epoch-retry')).toBe(1);
  expect(f.run().restored).toBe(false);
});

it('uses a headerless Yarn lock as a byte signal across processes', () => {
  const f = fixture();
  rmSync(f.path('pnpm-workspace.yaml'));
  rmSync(f.path('pnpm-lock.yaml'));
  f.write('package.json', '{"name":"fixture","packageManager":"yarn@1.22.22"}');
  const lock = f.path('yarn.lock');
  writeFileSync(lock, Buffer.from([0xff, 0x80]));
  const seed = f.run();
  expect(seed.error).toBeUndefined();
  expect(seed.snapshot.header.installations).toContainEqual(
    expect.objectContaining({
      locks: [[lock, expect.any(String), expect.any(String)]],
    }),
  );
  expect(f.run().restored).toBe(true);
  writeFileSync(lock, Buffer.from([0xff, 0x81]));
  utimesSync(lock, Date.now() / 1000 + 2, Date.now() / 1000 + 2);
  const changed = f.run();
  expect(changed.error).toBeUndefined();
  expect(changed.restored).toBe(false);
  expect(count(changed.events, 'read-block')).toBe(0);
});

it('gates the physical installation and detects a link rebound with identical lock bytes', () => {
  const f = fixture();
  for (const target of ['first', 'second']) {
    f.write(
      `${target}/package.json`,
      '{"name":"install","packageManager":"npm@11.0.0"}',
    );
    f.write(`${target}/package-lock.json`, 'opaque');
    mkdirSync(f.path(target, 'node_modules'));
  }
  const mount = f.path('node_modules');
  symlinkSync(f.path('first', 'node_modules'), mount, 'junction');
  expect(f.run().restored).toBe(false);
  expect(f.run().restored).toBe(true);
  rmSync(mount);
  symlinkSync(f.path('second', 'node_modules'), mount, 'junction');
  const rebound = f.run();
  expect(rebound.restored).toBe(false);
  expect(count(rebound.events, 'read-block')).toBe(0);
  expect(f.run().restored).toBe(true);
  rmSync(f.path('second', 'package-lock.json'));
  const unknown = f.run();
  expect(unknown.error).toBeUndefined();
  expect(unknown.restored).toBe(false);
  expect(f.run().restored).toBe(false);
});

it('restarts cold when a newly discovered project uses an independent lock, then gates that lock globally', () => {
  const f = fixture();
  const first = f.run();
  expect(first.error).toBeUndefined();
  f.write('leaf/package.json', '{"name":"leaf","packageManager":"npm@11.0.0"}');
  f.write(
    'leaf/tsconfig.json',
    '{"files":[],"compilerOptions":{"noLib":true}}',
  );
  const lock = f.path('leaf', 'package-lock.json');
  writeFileSync(lock, '{"lockfileVersion":3,"packages":{"":{}}}');
  const leaf = () => f.run('native', ['--leaf']);
  const discovered = leaf();
  expect(discovered.error).toBeUndefined();
  expect(discovered.restored).toBe(true);
  expect(discovered.analyses).toBe(2);
  expect(discovered.analyzedEpochs).toEqual([false]);
  expect(leaf().analyzedEpochs).toEqual([true]);
  writeFileSync(
    lock,
    '{"lockfileVersion":3,"packages":{"":{"name":"changed"}}}',
  );
  const changed = leaf();
  expect(changed.restored).toBe(false);
  expect(count(changed.events, 'read-block')).toBe(0);
  expect(changed.analyzedEpochs).toEqual([false]);
});

it('allows unexecuted variable imports without inventing dependencies or warnings', () => {
  const f = fixture();
  f.write(
    'limina.config.mjs',
    "const name='./never.mjs'; if(false) await import(name); export default {pipelines:{probe:[]}};",
  );
  const first = f.run();
  expect(first.restored).toBe(false);
  expect(first.snapshot.configModules.complete).toBe(true);
  expect(first.snapshot.configModules.resolutions).toEqual([]);
  expect(first.stderr).toBe('');
  const bytes = readFileSync(first.cachePath);
  expect(f.run().restored).toBe(true);
  expect(readFileSync(first.cachePath)).toEqual(bytes);
});

it('trusts equal mtimes, hashes touches and backdates per file, and makes comment-only changes cold', () => {
  const f = fixture();
  f.write('helper.mjs', 'export default {};');
  f.write('limina.config.mjs', 'export {default} from "./helper.mjs";');
  const cold = f.run();
  const bytes = readFileSync(cold.cachePath);
  const modified = statSync(cold.cachePath).mtimeMs;
  const warm = f.run();
  expect(warm.restored).toBe(true);
  expect(count(warm.events, 'config-modules-hashes')).toBe(0);
  const before = statSync(f.path('helper.mjs')).mtimeMs / 1000;
  for (const time of [before + 10, before - 100]) {
    utimesSync(f.path('helper.mjs'), time, time);
    const touched = f.run();
    expect(touched.restored).toBe(true);
    expect(count(touched.events, 'config-modules-hashes')).toBe(1);
    expect(readFileSync(cold.cachePath)).toEqual(bytes);
    expect(statSync(cold.cachePath).mtimeMs).toBe(modified);
  }
  f.write(
    'helper.mjs',
    'export default {}; // changed bytes, same config value',
  );
  expect(f.run().restored).toBe(false);
  expect(f.run().restored).toBe(true);
  const trusted = Math.floor(statSync(f.path('helper.mjs')).mtimeMs / 1000);
  writeFileSync(
    f.path('helper.mjs'),
    'export default {}; // hidden by restored mtime',
  );
  utimesSync(f.path('helper.mjs'), trusted, trusted);
  expect(f.run().restored).toBe(true);
});

it('retains tsx support for TypeScript imports from continuing callbacks after config evaluation', () => {
  const f = fixture('mts');
  f.write(
    'late.mts',
    'enum Value {answer=42}; export const answer=Value.answer;',
  );
  f.write(
    'limina.config.mts',
    `export default {package:{entries:[{name:'fixture',outDir:'dist',boundary:{environment:()=>{globalThis.late=import('./late.mts');return 'node';}}}]}};`,
  );
  const loader = new URL('../config/loader.ts', import.meta.url).href;
  f.write(
    'late-runner.mjs',
    `import {loadConfig} from ${JSON.stringify(loader)}; const config=await loadConfig({cwd:${JSON.stringify(f.root)},configLoader:'tsx'}); const environment=config.package.entries[0].boundary.environment(); const late=await globalThis.late; console.log(JSON.stringify({environment,answer:late.answer}));`,
  );
  const output = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
      f.path('late-runner.mjs'),
    ],
    { encoding: 'utf8' },
  );
  expect(output.status, output.stderr).toBe(0);
  expect(JSON.parse(output.stdout)).toEqual({
    environment: 'node',
    answer: 42,
  });
});

it.each(['native', 'tsx'])(
  'tracks executed variable imports with %s and preserves genuine load errors',
  (loader) => {
    const f = fixture();
    f.write('helper.mjs', 'export default {};');
    f.write(
      'limina.config.mjs',
      "const name='./helper.mjs'; export default (await import(name)).default;",
    );
    for (let invocation = 0; invocation < 2; invocation++) {
      const result = f.run(loader);
      expect(result.restored).toBe(invocation > 0);
      expect(result.snapshot.configModules.complete).toBe(true);
      expect(result.stderr).toBe('');
    }
    f.write(
      'limina.config.mjs',
      "const name='./missing.mjs'; export default (await import(name)).default;",
    );
    const failed = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        f.path('runner.mjs'),
        loader,
      ],
      { encoding: 'utf8' },
    );
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('missing.mjs');
  },
);

it.each(['native', 'tsx'])(
  'distinguishes TS import types and import.meta with %s from runtime dynamic imports',
  (loader) => {
    const f = fixture('mts');
    f.write('helper.mjs', 'export default {};');
    f.write(
      'limina.config.mts',
      "type T = import('./never-loaded-types').T; void import.meta.url;\nawait import('./helper.mjs'); await import(`./helper.mjs`); export default {};",
    );
    const first = f.run(loader);
    expect(first.stderr).toBe('');
    expect(first.snapshot.configModules.complete).toBe(true);
    expect(f.run(loader).restored).toBe(true);
  },
);

it('observes original createRequire requests and newly selected CJS candidates without reusing stale children', () => {
  const f = fixture();
  f.write(
    'package.json',
    JSON.stringify({
      name: 'fixture',
      private: true,
      type: 'commonjs',
      packageManager: 'pnpm@11.28.3',
    }),
  );
  f.write('choice/package.json', '{"type":"commonjs"}');
  f.write('choice/index.js', 'module.exports = {};');
  f.write(
    'limina.config.mjs',
    "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); export default require('./choice');",
  );
  const choiceIndexURL = pathToFileURL(f.path('choice/index.js')).href;
  const choiceFileURL = pathToFileURL(f.path('choice.js')).href;
  const first = f.run();
  expect(first.snapshot.configModules.resolutions).toContainEqual(
    expect.objectContaining({
      specifier: './choice',
      resolvedURL: choiceIndexURL,
    }),
  );
  f.write('choice.js', 'module.exports = {};');
  const switched = f.run();
  expect(switched.restored).toBe(false);
  expect(switched.snapshot.configModules.resolutions).toContainEqual(
    expect.objectContaining({
      specifier: './choice',
      resolvedURL: choiceFileURL,
    }),
  );
});

it('makes an exited and deleted helper cold rather than invocation drift, and tracks symlink bindings', () => {
  const f = fixture();
  f.write('helper.mjs', 'export default {};');
  f.write('other.mjs', 'export default {};');
  symlinkSync(f.path('helper.mjs'), f.path('alias.mjs'));
  f.write('limina.config.mjs', 'export {default} from "./alias.mjs";');
  expect(f.run().snapshot.configModules.complete).toBe(true);
  expect(f.run().restored).toBe(true);
  rmSync(f.path('alias.mjs'));
  symlinkSync(f.path('other.mjs'), f.path('alias.mjs'));
  expect(f.run().restored).toBe(false);
  f.write('limina.config.mjs', 'export default {};');
  rmSync(f.path('other.mjs'));
  const exit = f.run();
  expect(exit.restored).toBe(false);
  expect(exit.error).toBeUndefined();
  expect(
    exit.snapshot.configModules.files.map((entry) => entry.path),
  ).not.toContain(f.path('other.mjs'));
});

it.each(['native', 'tsx'])(
  'stops %s factory evaluation when a CJS helper changes after loading',
  (backend) => {
    const f = fixture();
    f.write('helper.cjs', 'module.exports={};');
    f.write(
      'limina.config.mjs',
      "import {createRequire} from 'node:module'; import {writeFileSync} from 'node:fs'; const require=createRequire(import.meta.url); export default ()=>{require('./helper.cjs'); writeFileSync(new URL('./helper.cjs',import.meta.url),'module.exports={}; // changed'); return {};};",
    );
    const failed = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
        f.path('runner.mjs'),
        backend,
      ],
      { encoding: 'utf8' },
    );
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain(
      'configuration module changed during evaluation',
    );
    expect(failed.stderr).toContain('helper.cjs');
  },
);

it('makes changed resolution edges cold when members, bytes and effective values are unchanged', () => {
  const f = fixture();
  f.write('b.mjs', 'export {};');
  f.write('c.mjs', 'export {};');
  f.write(
    'a.mjs',
    "await (process.env.EDGE_CASE==='b' ? import('./b.mjs') : import('./c.mjs')); export {};",
  );
  f.write(
    'limina.config.mjs',
    "import './a.mjs'; import './b.mjs'; import './c.mjs'; export default {};",
  );
  const first = f.run();
  expect(first.snapshot.configModules.complete).toBe(true);
  expect(f.run().restored).toBe(true);
  const changed = f.run('native', [], { EDGE_CASE: 'b' });
  expect(changed.snapshot.configModules.files.map((file) => file.path)).toEqual(
    first.snapshot.configModules.files.map((file) => file.path),
  );
  expect(changed.snapshot.header.configVersion).toBe(
    first.snapshot.header.configVersion,
  );
  expect(changed.restored).toBe(false);
  expect(count(changed.events, 'config-modules-result-resolutions')).toBe(1);
  expect(count(changed.events, 'config-modules-hashes')).toBe(0);
});

it('publishes fresh configuration module hashes after a governing lock change', () => {
  const f = fixture();
  f.write('helper.mjs', 'export default 1;');
  f.write('limina.config.mjs', "import './helper.mjs'; export default {};");
  const helper = f.path('helper.mjs');
  utimesSync(helper, 1, 1);
  f.run();
  const changed = 'export default 2;';
  writeFileSync(helper, changed);
  utimesSync(helper, 1, 1);
  f.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters: {'.': {}}");
  const cold = f.run();
  expect(cold.error).toBeUndefined();
  expect(cold.restored).toBe(false);
  expect(count(cold.events, 'read-block')).toBe(0);
  expect(cold.snapshot.configModules.files).toContainEqual(
    expect.objectContaining({
      path: helper,
      contentHash: createHash('sha256').update(changed).digest('hex'),
    }),
  );
});

it('preserves explicit user queries, effective values, forced cold publication, and the drift stop boundary', () => {
  const f = fixture();
  f.write('helper.mjs', 'export default {};');
  f.write(
    'limina.config.mjs',
    "await import('./helper.mjs?liminaInvocation=user#explicit'); export default {pipelines:{[process.env.CONFIG_CASE ?? 'probe']:[]}};",
  );
  const first = f.run();
  expect(
    first.snapshot.configModules.resolutions.some((edge) =>
      edge.resolvedURL.endsWith('?liminaInvocation=user#explicit'),
    ),
  ).toBe(true);
  expect(f.run().restored).toBe(true);
  expect(f.run('native', [], { CONFIG_CASE: 'second' }).restored).toBe(false);
  const forced = f.run('native', ['--force'], { CONFIG_CASE: 'second' });
  expect(forced.restored).toBe(false);
  expect(f.run('native', [], { CONFIG_CASE: 'second' }).restored).toBe(true);
  const bytes = readFileSync(first.cachePath);
  const drifted = f.run('native', ['--drift'], { CONFIG_CASE: 'second' });
  expect(drifted.error).toContain('Run the command again');
  expect(drifted.analyses).toBe(1);
  expect(readFileSync(first.cachePath)).toEqual(bytes);
});

it.each(['json', 'ndjson'])(
  'keeps %s issue queries parseable after a warning and atomic incomplete publication',
  (format) => {
    const f = fixture();
    f.write(
      'limina.config.mjs',
      "await import('data:text/javascript,export default {}'); export default {pipelines:{probe:['graph:check']}};",
    );
    const cli = fileURLToPath(new URL('../../bin/limina.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'check', 'probe'], {
      cwd: f.root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('module-scheme-unknown');
    const store = new AnalysisCacheStore({
      namespace: createLiminaArtifactNamespace({
        rootDir: f.root,
        generation: 0,
      }),
      identity: 'path-only',
      configPath: f.path('limina.config.mjs'),
    });
    const snapshot = JSON.parse(
      readFileSync(store.path, 'utf8'),
    ) as AnalysisSnapshot;
    expect(snapshot.configModules.complete).toBe(false);
    expect(snapshot.configModules.otherUnknownReasons).toContain(
      'module-scheme-unknown',
    );
    rmSync(f.path('limina.config.mjs'));
    const query = spawnSync(
      process.execPath,
      [
        cli,
        'check',
        '--issues',
        '--config',
        f.path('limina.config.mjs'),
        '--format',
        format,
      ],
      { cwd: f.root, encoding: 'utf8' },
    );
    expect(query.status, query.stderr).toBe(0);
    const records =
      format === 'json'
        ? [JSON.parse(query.stdout)]
        : query.stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    expect(records.length).toBe(format === 'json' ? 1 : 0);
    expect(query.stderr).not.toContain('module-scheme-unknown');
    expect(readFileSync(store.path, 'utf8')).toBe(
      `${JSON.stringify(snapshot)}\n`,
    );
  },
);

it('keeps node-resolved data URLs incomplete while continuing normal configuration evaluation', () => {
  const f = fixture();
  f.write(
    'limina.config.mjs',
    "await import('data:text/javascript,export default {}'); export default {};",
  );
  const result = f.run();
  expect(result.snapshot.configModules.complete).toBe(false);
  expect(JSON.stringify(result.snapshot.configModules)).not.toContain(
    'data:text/javascript',
  );
  expect(result.snapshot.configModules.otherUnknownReasons).toContain(
    'module-scheme-unknown',
  );
  expect(f.run().restored).toBe(false);
});

it('freshly evaluates a symlinked entry and its relative helpers while retaining its logical binding', () => {
  const f = fixture();
  f.write(
    'config/helper.mjs',
    "import {appendFileSync} from 'node:fs'; appendFileSync(new URL('../evaluations',import.meta.url),'run\\n'); export default {};",
  );
  f.write('config/actual.mjs', 'export {default} from "./helper.mjs";');
  rmSync(f.path('limina.config.mjs'));
  symlinkSync(f.path('config/actual.mjs'), f.path('limina.config.mjs'));
  const first = f.run();
  expect(first.snapshot.configModules.complete).toBe(true);
  expect(first.snapshot.configModules.files).toContainEqual(
    expect.objectContaining({
      path: f.path('config/actual.mjs'),
      logicalPath: f.path('limina.config.mjs'),
      logicalBinding: expect.any(String),
    }),
  );
  expect(f.run().restored).toBe(true);
  expect(readFileSync(f.path('evaluations'), 'utf8')).toBe('run\nrun\n');
});

it('keeps the public defineConfig entry eligible without loading the configuration execution machinery', () => {
  const f = fixture('mts');
  const entry = new URL('../index.ts', import.meta.url).href;
  f.write(
    'limina.config.mts',
    `import {defineConfig} from ${JSON.stringify(entry)}; export default defineConfig({pipelines:{probe:[]}});`,
  );
  const first = f.run();
  expect(first.snapshot.configModules.complete).toBe(true);
  expect(first.stderr).toBe('');
  expect(f.run().restored).toBe(true);
});

it.each<{
  gate: string;
  reason: string;
  corrupt(snapshot: AnalysisSnapshot, helperPath: string): void;
}>([
  {
    gate: 'schema',
    reason: 'missing',
    corrupt: (s) => {
      Object.assign(s.header, { schema: 4 });
    },
  },
  {
    gate: 'config version',
    reason: 'match',
    corrupt: (s) => {
      s.header.configVersion = 'changed';
    },
  },
  {
    gate: 'module evidence',
    reason: 'missing',
    corrupt: (s) => {
      Reflect.deleteProperty(s, 'configModules');
    },
  },
  {
    gate: 'incomplete coverage',
    reason: 'old-incomplete',
    corrupt: (s) => {
      s.configModules.complete = false;
      s.configModules.otherUnknownReasons = ['unobserved'];
    },
  },
  {
    gate: 'inconsistent coverage',
    reason: 'missing',
    corrupt: (s) => {
      s.configModules.otherUnknownReasons = ['unobserved'];
    },
  },
  {
    gate: 'source provenance',
    reason: 'missing',
    corrupt: (s) => {
      delete s.configModules.files.find((file) => file.role === 'module')!
        .sourceKind;
    },
  },
  {
    gate: 'content',
    reason: 'content',
    corrupt: (s, helperPath) => {
      s.configModules.files.find(
        (file) => file.path === helperPath,
      )!.contentHash = '0'.repeat(64);
      s.configModules.files.find(
        (file) => file.path === helperPath,
      )!.metadata.mtimeMs! -= 1000;
    },
  },
  {
    gate: 'binding',
    reason: 'binding-or-kind',
    corrupt: (s, helperPath) => {
      s.configModules.files.find((file) => file.path === helperPath)!.binding =
        'changed';
    },
  },
  {
    gate: 'resolution edges',
    reason: 'resolutions',
    corrupt: (s) => {
      s.configModules.resolutions[0].specifier = './other.mjs';
    },
  },
])(
  'rejects a corrupted snapshot after a positive store restoration control ($gate)',
  ({ reason, corrupt }) => {
    const f = fixture();
    f.write('helper.mjs', 'export default {};');
    f.write('limina.config.mjs', 'export {default} from "./helper.mjs";');
    const cold = f.run();
    const warm = f.run();
    expect(warm.restored).toBe(true);
    expect(warm.adoptedInputs).toEqual([f.path('tsconfig.json')]);
    const baseline = readFileSync(cold.cachePath, 'utf8');
    const snapshot = JSON.parse(baseline) as AnalysisSnapshot;
    corrupt(snapshot, f.path('helper.mjs'));
    writeFileSync(cold.cachePath, JSON.stringify(snapshot));
    const rejected = f.run();
    expect(rejected.restored, reason).toBe(false);
    expect(rejected.adoptedInputs, reason).toEqual([]);
    expect(count(rejected.events, 'read-block')).toBe(0);
    expect(count(rejected.events, `config-modules-result-${reason}`)).toBe(1);
    if (reason !== 'match')
      expect(rejected.events.some((event) => event.kind === 'validation')).toBe(
        false,
      );
    expect(f.run().restored).toBe(true);
  },
);

it.each([
  ['native', false],
  ['native', true],
  ['tsx', false],
  ['tsx', true],
])(
  'versions observed %s loader output without classifying syntax (initially transformed: %s)',
  (loader, initiallyTransformed) => {
    const f = fixture();
    const before = initiallyTransformed ? ['--transform'] : [];
    const after = initiallyTransformed ? [] : ['--transform'];
    const initial = f.run(loader, before);
    expect(initial.restored).toBe(false);
    expect(initial.snapshot.configModules.complete).toBe(true);
    expect(f.run(loader, before).restored).toBe(true);
    const changed = f.run(loader, after);
    expect(changed.restored).toBe(false);
    expect(changed.adoptedInputs).toEqual([]);
    expect(changed.snapshot.configModules.complete).toBe(true);
    const entry = changed.snapshot.configModules.files.find(
      (file) => file.path === f.path('limina.config.mjs'),
    );
    expect(entry?.sourceKind).toBe(initiallyTransformed ? 'disk' : 'loader');
    expect(entry?.loadedSource).toEqual(
      initiallyTransformed ? undefined : { contentHash: expect.any(String) },
    );
    expect(count(changed.events, 'config-modules-result-content')).toBe(1);
    expect(count(changed.events, 'config-modules-loaderSourceHashes')).toBe(
      initiallyTransformed ? 0 : 1,
    );
    expect(f.run(loader, after).restored).toBe(true);
  },
);

it.each([false, true])(
  'stops after one analysis when a declared file drifts (initially missing: %s)',
  (missing) => {
    const f = fixture();
    const dependency = f.path('rules.json');
    if (!missing) f.write('rules.json', '{}');
    f.write(
      'limina.config.mjs',
      `export default {cache:{dependencies:[${JSON.stringify(dependency)}]}};`,
    );
    const seed = f.run();
    expect(f.run().restored).toBe(true);
    const bytes = readFileSync(seed.cachePath);
    const drifted = f.run('native', ['--dependency-drift']);
    expect(drifted.error).toContain('Run the command again');
    expect(drifted.analyses).toBe(1);
    expect(readFileSync(seed.cachePath)).toEqual(bytes);
  },
);
