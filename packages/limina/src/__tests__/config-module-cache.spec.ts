import { spawnSync } from 'node:child_process';
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
import type { AnalysisSnapshot } from '../core/analysis-cache/contracts';
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
  write('analysis-input', 'unchanged');
  write(
    'tsconfig.json',
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
import {readFileSync,writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
if(process.argv.includes('--transform'))registerHooks({load(url,context,next){const result=next(url,context);return url.startsWith(${JSON.stringify(entryURL)})?{...result,source:String(result.source)+'\\nif(false){const target="./never.mjs"; await import(target);}'}:result;}});
const config = await loadConfig({cwd:${JSON.stringify(root)},configLoader:process.argv[2]});
const namespace = createLiminaArtifactNamespace({rootDir:config.rootDir,generation:0});
const events=[];
const controller = new AnalysisCacheController(config,namespace,{force:process.argv.includes('--force'),metrics:{record:event=>events.push(event)}});
const restored=controller.cache.previous!==undefined;
const adoptedInputs=Object.keys(controller.cache.inputs.records);
let analyses=0;
let error;
try {
  await controller.analyze({analyze:async()=>{
    analyses++;
    controller.cache.inputs.observeConfig(parseProjectConfigWithExtensions({configPath:${JSON.stringify(file('tsconfig.json'))},projectRootDir:${JSON.stringify(root)}},[]).configClosure);
    if(process.argv.includes('--drift'))writeFileSync(config.configPath,'export default {}; // changed during invocation');
    if(process.argv.includes('--dependency-drift'))writeFileSync(config.configDependencies[0],'changed while analyzing');
  },refresh:()=>controller.refresh()});
  await controller.publish();
}catch(caught){error=caught.message;}
const store=new AnalysisCacheStore({namespace,identity:'path-only',configPath:config.configPath});
let snapshot;
try{snapshot=JSON.parse(readFileSync(store.path,'utf8'));}catch{}
console.log(JSON.stringify({restored,events,snapshot,cachePath:store.path,adoptedInputs,analyses,error}));`,
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
    expect(warm.adoptedInputs).toHaveLength(1);
    const baseline = readFileSync(cold.cachePath, 'utf8');
    const snapshot = JSON.parse(baseline) as AnalysisSnapshot;
    corrupt(snapshot, f.path('helper.mjs'));
    writeFileSync(cold.cachePath, JSON.stringify(snapshot));
    const rejected = f.run();
    expect(rejected.restored, reason).toBe(false);
    expect(rejected.adoptedInputs, reason).toEqual([]);
    expect(count(rejected.events, `config-modules-result-${reason}`)).toBe(1);
    if (reason !== 'match')
      expect(rejected.events.some((event) => event.kind === 'validation')).toBe(
        false,
      );
    expect(f.run().restored).toBe(true);
  },
);

it.each(['native', 'tsx'])(
  'versions observed %s loader output without classifying its unexecuted syntax',
  (loader) => {
    const f = fixture();
    expect(f.run(loader).snapshot.configModules.complete).toBe(true);
    expect(f.run(loader).restored).toBe(true);
    const transformed = f.run(loader, ['--transform']);
    expect(transformed.restored).toBe(false);
    expect(transformed.adoptedInputs).toEqual([]);
    expect(transformed.snapshot.configModules.complete).toBe(true);
    expect(count(transformed.events, 'config-modules-result-content')).toBe(1);
    expect(count(transformed.events, 'config-modules-loaderSourceHashes')).toBe(
      1,
    );
    expect(f.run(loader, ['--transform']).restored).toBe(true);
    expect(f.run(loader).restored).toBe(false);
    expect(f.run(loader).restored).toBe(true);
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
      `export default {configDependencies:[${JSON.stringify(dependency)}]};`,
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
