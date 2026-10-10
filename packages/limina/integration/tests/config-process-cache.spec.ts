import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createFixturePathResolver } from '../../src/__tests__/helpers/path';
import type { AnalysisSnapshot } from '../../src/core/analysis-cache/contracts';
import { runLimina } from '../helpers/run-limina';

const cli = fileURLToPath(new URL('../../dist/bin/limina.js', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(extension: string) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-process-cache-'));
  const root = realpathSync.native(temporary);
  roots.push(root);
  const file = createFixturePathResolver(root);
  const write = (name: string, text: string) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(file(name), text);
  };
  write(
    'package.json',
    '{"name":"fixture","private":true,"type":"module","packageManager":"npm@11.6.1"}',
  );
  write('package-lock.json', '{"lockfileVersion":3,"packages":{"":{}}}');
  write(
    'tsconfig.json',
    '{"compilerOptions":{"composite":true,"declaration":true,"noLib":true,"types":[],"module":"NodeNext","outDir":"dist"},"include":["src/**/*.ts"]}',
  );
  write('src/a.ts', 'export const value=1;');
  const value = JSON.stringify({
    config: { checkers: { tsc: { include: ['tsconfig.json'] } } },
    pipelines: { probe: ['graph:check'] },
  });
  const entry = `limina.config.${extension}`;
  const helper = `helper.${extension}`;
  const declaration =
    extension === 'cjs'
      ? `module.exports=${value};`
      : `export default ${value};`;
  write(
    helper,
    extension === 'mts'
      ? `const enabled: boolean = true; void enabled; ${declaration}`
      : declaration,
  );
  write(
    entry,
    extension === 'cjs'
      ? `module.exports=require('./${helper}');`
      : `export {default} from './${helper}';`,
  );
  return { root, path: file, write, entry, helper, declaration };
}
function artifact(f: ReturnType<typeof fixture>, suffix: string): string {
  const name = readdirSync(f.path('.limina'), { recursive: true })
    .map(String)
    .find((value) => value.endsWith(suffix));
  expect(name).toBeDefined();
  return f.path('.limina', name!);
}
interface Metric {
  name?: string;
  kind?: string;
  count?: number;
}
function count(events: Metric[], kind: string): number {
  return events.find((event) => event.kind === kind)?.count ?? 0;
}
async function runProfile(
  f: ReturnType<typeof fixture>,
  loader: string,
  options: { env?: Record<string, string>; args?: string[] } = {},
) {
  expect(
    existsSync(cli),
    'Build Limina before process-cache integration tests.',
  ).toBe(true);
  const result = await runLimina({
    fixtureName: 'process-cache',
    cwd: f.root,
    entry: { executable: process.execPath, args: [cli] },
    args: [
      'check',
      'probe',
      '--config',
      f.path(f.entry),
      '--config-loader',
      loader,
      ...(options.args ?? []),
    ],
    env: { NODE_OPTIONS: '', LIMINA_PROFILE: '1', ...options.env },
  });
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const profile = JSON.parse(
    readFileSync(artifact(f, 'last-profile.json'), 'utf8'),
  ) as { metrics: Metric[] };
  return { events: profile.metrics };
}
async function check(
  f: ReturnType<typeof fixture>,
  loader: string,
  options: { env?: Record<string, string>; args?: string[] } = {},
) {
  const profile = await runProfile(f, loader, options);
  const snapshotPath = artifact(f, 'snapshot.json');
  const snapshot = JSON.parse(
    readFileSync(snapshotPath, 'utf8'),
  ) as AnalysisSnapshot;
  return { ...profile, snapshot, path: snapshotPath };
}
it.each([
  ['native', 'mjs'],
  ['native', 'cjs'],
  ['native', 'mts'],
  ['tsx', 'mts'],
])(
  'restores %s/%s in a new CLI process and preserves clean snapshot bytes',
  async (loader, extension) => {
    const f = fixture(extension);
    const cold = await check(f, loader);
    expect(cold.snapshot.configModules.complete).toBe(true);
    expect(count(cold.events, 'semanticPrograms')).toBeGreaterThan(0);
    const bytes = readFileSync(cold.path);
    const timestamp = statSync(cold.path).mtimeMs;
    const warm = await check(f, loader);
    expect(count(warm.events, 'semanticPrograms')).toBe(0);
    expect(count(warm.events, 'graphHits')).toBe(1);
    const mtime = statSync(f.path(f.helper)).mtimeMs / 1000;
    utimesSync(f.path(f.helper), mtime + 100, mtime + 100);
    const touch = await check(f, loader);
    expect(count(touch.events, 'config-modules-hashes')).toBe(1);
    expect(count(touch.events, 'semanticPrograms')).toBe(0);
    expect(readFileSync(cold.path)).toEqual(bytes);
    expect(statSync(cold.path).mtimeMs).toBe(timestamp);
    f.write(
      f.helper,
      `${f.declaration} // changed module, identical configuration`,
    );
    const changed = await check(f, loader);
    expect(count(changed.events, 'semanticPrograms')).toBeGreaterThan(0);
    expect(count(changed.events, 'graphHits')).toBe(0);
  },
);
it('keeps tsx CommonJS cold when its extension hook bypasses source observation', async () => {
  const f = fixture('cjs');
  await check(f, 'tsx');
  const next = await check(f, 'tsx');
  expect(next.snapshot.configModules.complete).toBe(false);
  expect(count(next.events, 'graphHits')).toBe(0);
  expect(count(next.events, 'semanticPrograms')).toBeGreaterThan(0);
  expect(next.snapshot.configModules.otherUnknownReasons).toContain(
    `module-format-unobserved:${f.path(f.entry)}`,
  );
});
it.each(['native', 'tsx'])(
  'preserves one evaluation when a %s configuration factory imports its own URL',
  async (loader) => {
    const f = fixture('mjs');
    f.write(
      f.entry,
      `import config from './helper.mjs';
globalThis.configLoads=(globalThis.configLoads??0)+1;
if(globalThis.configLoads>1)throw new Error('configuration executed twice');
export default async()=>{await import(import.meta.url);return config;};`,
    );
    const result = await check(f, loader);
    expect(result.snapshot.configModules.complete).toBe(true);
    expect(count(result.events, 'graphHits')).toBe(0);
    expect(count((await check(f, loader)).events, 'graphHits')).toBe(1);
  },
);
it.each([
  ['--require', 'preload.cjs'],
  ['--import', 'preload.cjs'],
  ['--import', 'tsx'],
])(
  'rejects untrusted %s %s before evaluating configuration or replacing a snapshot',
  async (flag, request) => {
    const f = fixture('mjs');
    const seed = await check(f, 'native');
    const bytes = readFileSync(seed.path);
    f.write('preload.cjs', 'globalThis.preloaded=true;');
    f.write(
      'node_modules/tsx/package.json',
      '{"name":"tsx","version":"0.0.0-fixture","main":"./index.cjs"}',
    );
    f.write('node_modules/tsx/index.cjs', 'globalThis.preloaded=true;');
    f.write(f.entry, "throw new Error('configuration must not execute');");
    const preload = request === 'tsx' ? request : f.path(request);
    const startupRequest =
      flag === '--import' && request !== 'tsx'
        ? pathToFileURL(preload).href
        : preload;
    const result = await runLimina({
      fixtureName: 'preloaded-cache',
      cwd: f.root,
      entry: {
        executable: process.execPath,
        args: [flag, startupRequest, cli],
      },
      args: ['check', 'probe', '--config', f.path(f.entry)],
      env: { NODE_OPTIONS: '' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('custom Node startup preloads or loaders');
    expect(result.stderr).not.toContain('configuration must not execute');
    expect(readFileSync(seed.path)).toEqual(bytes);
  },
);

function expectCache(
  result: Awaited<ReturnType<typeof check>>,
  isWarm: boolean,
): void {
  expect(count(result.events, 'graphHits')).toBe(isWarm ? 1 : 0);
  expect(count(result.events, 'semanticPrograms') === 0).toBe(isWarm);
}

it.each(['native', 'tsx'])(
  'uses the actual %s variable-import closure across processes',
  async (loader) => {
    const f = fixture('mjs');
    f.write('other.mjs', 'export default {};');
    f.write(
      f.entry,
      `import config from './helper.mjs'; const target=process.env.FEATURE_MODULE; if(target) await import(target); export default config;`,
    );
    for (const [target, warm] of [
      ['', false],
      ['', true],
      ['./other.mjs', false],
      ['./other.mjs', true],
      ['', false],
      ['', true],
    ] as const) {
      const result = await check(f, loader, {
        env: { FEATURE_MODULE: target },
      });
      expect(result.snapshot.configModules.complete).toBe(true);
      expectCache(result, warm);
      expect(
        result.snapshot.configModules.files.some(
          (file) => file.path === f.path('other.mjs'),
        ),
      ).toBe(target !== '');
    }
  },
);

it.each(['require', 'createRequire', 'anchored createRequire'])(
  'retains the original %s request when a higher-priority CJS candidate appears',
  async (style) => {
    const f = fixture(style === 'require' ? 'cjs' : 'mjs');
    const manifest = JSON.parse(readFileSync(f.path('package.json'), 'utf8'));
    f.write('package.json', JSON.stringify({ ...manifest, type: 'commonjs' }));
    f.write('choice/package.json', '{"type":"commonjs"}');
    f.write(
      'choice/index.js',
      `module.exports=${f.declaration.replace(/^export default |^module.exports=/u, '')}`,
    );
    const source =
      style === 'require'
        ? "module.exports=require('./choice');"
        : `import {createRequire} from 'node:module'; const require=createRequire(${style === 'createRequire' ? 'import.meta.url' : "new URL('./anchor.cjs',import.meta.url)"}); export default require('./choice');`;
    f.write(f.entry, source);
    const first = await check(f, 'native');
    expectCache(first, false);
    const indexURL = pathToFileURL(f.path('choice/index.js')).href;
    expect(first.snapshot.configModules.resolutions).toContainEqual(
      expect.objectContaining({
        specifier: './choice',
        resolvedURL: indexURL,
      }),
    );
    expectCache(await check(f, 'native'), true);
    f.write(
      'choice.js',
      `module.exports=${f.declaration.replace(/^export default |^module.exports=/u, '')}`,
    );
    const changed = await check(f, 'native');
    expectCache(changed, false);
    const fileURL = pathToFileURL(f.path('choice.js')).href;
    expect(changed.snapshot.configModules.resolutions).toContainEqual(
      expect.objectContaining({
        specifier: './choice',
        resolvedURL: fileURL,
      }),
    );
    expectCache(await check(f, 'native'), true);
  },
);

it.each(['imports', 'exports', 'symlink'])(
  'invalidates an actual %s resolution change with equal exports',
  async (kind) => {
    const f = fixture('mjs');
    f.write('a.mjs', 'export {};');
    f.write('b.mjs', 'export {};');
    const manifest = JSON.parse(readFileSync(f.path('package.json'), 'utf8'));
    const select = (target: string) => {
      if (kind === 'imports')
        f.write(
          'package.json',
          JSON.stringify({
            ...manifest,
            imports: { '#choice': `./${target}.mjs` },
          }),
        );
      else if (kind === 'exports')
        f.write(
          'node_modules/choice/package.json',
          JSON.stringify({
            name: 'choice',
            type: 'module',
            exports: `./${target}.mjs`,
          }),
        );
      else {
        if (existsSync(f.path('alias.mjs'))) rmSync(f.path('alias.mjs'));
        symlinkSync(f.path(`${target}.mjs`), f.path('alias.mjs'));
      }
    };
    f.write('node_modules/choice/a.mjs', 'export {};');
    f.write('node_modules/choice/b.mjs', 'export {};');
    select('a');
    const request =
      kind === 'imports'
        ? '#choice'
        : kind === 'exports'
          ? 'choice'
          : './alias.mjs';
    f.write(
      f.entry,
      `import '${request}'; export { default } from './helper.mjs';`,
    );
    const cold = await check(f, 'native');
    expectCache(cold, false);
    expectCache(await check(f, 'native'), true);
    select('b');
    const changed = await check(f, 'native');
    expectCache(changed, false);
    expect(changed.snapshot.header.configVersion).toBe(
      cold.snapshot.header.configVersion,
    );
    expectCache(await check(f, 'native'), true);
  },
);

it.each(['native', 'tsx'])(
  'versions explicit %s file content independently of evaluated values',
  async (loader) => {
    const f = fixture('mjs');
    f.write('rules.json', '{"ignored":1}');
    f.write(
      f.entry,
      "import config from './helper.mjs'; import {readFileSync} from 'node:fs'; JSON.parse(readFileSync(new URL('./rules.json',import.meta.url),'utf8')); export default {...config,cache:{dependencies:['./rules.json']}};",
    );
    const cold = await check(f, loader);
    expectCache(cold, false);
    expectCache(await check(f, loader), true);
    const bytes = readFileSync(cold.path);
    const modified = statSync(cold.path).mtimeMs;
    const time = statSync(f.path('rules.json')).mtimeMs / 1000;
    utimesSync(f.path('rules.json'), time + 100, time + 100);
    const touch = await check(f, loader);
    expectCache(touch, true);
    expect(count(touch.events, 'config-modules-hashes')).toBe(1);
    expect(readFileSync(cold.path)).toEqual(bytes);
    expect(statSync(cold.path).mtimeMs).toBe(modified);
    f.write('rules.json', '{"ignored":2}');
    const changed = await check(f, loader);
    expectCache(changed, false);
    expect(changed.snapshot.header.configVersion).toBe(
      cold.snapshot.header.configVersion,
    );
    expect(count(changed.events, 'config-modules-result-content')).toBe(1);
    expectCache(await check(f, loader), true);
  },
);

it('observes missing declared files, deduplicates aliases, retains module roles and tracks declaration changes', async () => {
  const f = fixture('mjs');
  f.write('a.json', '{}');
  f.write('b.json', '{}');
  symlinkSync(f.path('a.json'), f.path('alias.json'));
  f.write(
    'config/limina.config.mjs',
    `import config from '../helper.mjs'; export default {...config,cache:{dependencies:['../alias.json','.././alias.json','../a.json','../helper.mjs','../optional.json',...(process.env.EXTRA_DEPENDENCY?['../extra.json']:[])]}};`,
  );
  f.entry = 'config/limina.config.mjs';
  const seed = await check(f, 'native');
  expectCache(seed, false);
  expectCache(await check(f, 'native'), true);
  expect(seed.snapshot.configModules.dependencies).toHaveLength(4);
  expect(
    seed.snapshot.configModules.files.filter(
      (file) => file.path === f.path('a.json'),
    ),
  ).toHaveLength(1);
  expect(
    seed.snapshot.configModules.files.find(
      (file) => file.path === f.path('helper.mjs'),
    )?.role,
  ).toBe('module');
  f.write('optional.json', '{}');
  expectCache(await check(f, 'native'), false);
  expectCache(await check(f, 'native'), true);
  rmSync(f.path('optional.json'));
  expectCache(await check(f, 'native'), false);
  expectCache(await check(f, 'native'), true);
  rmSync(f.path('alias.json'));
  symlinkSync(f.path('b.json'), f.path('alias.json'));
  expectCache(await check(f, 'native'), false);
  expectCache(await check(f, 'native'), true);
  rmSync(f.path('b.json'));
  expectCache(await check(f, 'native'), false);
  expectCache(await check(f, 'native'), true);
  f.write('b.json', '{}');
  expectCache(await check(f, 'native'), false);
  expectCache(await check(f, 'native'), true);
  expectCache(
    await check(f, 'native', { env: { EXTRA_DEPENDENCY: '1' } }),
    false,
  );
  expectCache(
    await check(f, 'native', { env: { EXTRA_DEPENDENCY: '1' } }),
    true,
  );
});

it.each([undefined, true, { dependencies: [] }])(
  'keeps enabled cache %j cold, warm and refreshable through real --force',
  async (cache) => {
    const f = fixture('mjs');
    f.write(
      f.entry,
      `import config from './helper.mjs'; export default {...config, ...${JSON.stringify({ cache })}};`,
    );
    const seed = await check(f, 'native');
    expectCache(seed, false);
    expectCache(await check(f, 'native'), true);
    const before = readFileSync(seed.path);
    const forced = await check(f, 'native', { args: ['--force'] });
    expectCache(forced, false);
    expect(forced.events).toContainEqual(
      expect.objectContaining({ name: 'analysis-cache', kind: 'read-bytes' }),
    );
    expect(
      forced.events.some(
        (event) =>
          event.name === 'analysis-cache' &&
          ['parse', 'validation'].includes(event.kind ?? ''),
      ),
    ).toBe(false);
    expect(forced.events).toContainEqual(
      expect.objectContaining({ name: 'analysis-cache', kind: 'write' }),
    );
    expect(readFileSync(seed.path)).not.toEqual(before);
    expectCache(await check(f, 'native'), true);
  },
);

it.each([
  ['native', 'mjs', true],
  ['tsx', 'mjs', true],
  ['native', 'mjs', false],
  ['tsx', 'mts', false],
] as const)(
  'keeps cache: false cold with %s/%s (enumerable: %s), leaves snapshots intact and preserves issue queries',
  async (loader, extension, enumerable) => {
    const f = fixture(extension);
    f.write(
      f.entry,
      `import config from './${f.helper}'; export default async () => Object.defineProperty({...config}, 'cache', {
        value:process.env.DISABLE_CACHE==='1'?false:true,enumerable:${enumerable}
      });`,
    );
    const disabledOptions = { env: { DISABLE_CACHE: '1' } };
    const initial = await runProfile(f, loader, disabledOptions);
    expect(
      initial.events.some((event) => event.name === 'analysis-cache'),
    ).toBe(false);
    expect(initial.events).toContainEqual(
      expect.objectContaining({ name: 'bounded-program-create' }),
    );
    expect(
      readdirSync(f.path('.limina'), { recursive: true }).some((entry) =>
        String(entry).endsWith('snapshot.json'),
      ),
    ).toBe(false);
    const seed = await check(f, loader);
    expectCache(await check(f, loader), true);
    const bytes = readFileSync(seed.path);
    const modified = statSync(seed.path).mtimeMs;
    for (const arguments_ of [[], ['--force']]) {
      const disabled = await runProfile(f, loader, {
        ...disabledOptions,
        args: arguments_,
      });
      expect(
        disabled.events.some((event) => event.name === 'analysis-cache'),
      ).toBe(false);
      expect(disabled.events).toContainEqual(
        expect.objectContaining({ name: 'bounded-program-create' }),
      );
      expect(readFileSync(seed.path)).toEqual(bytes);
      expect(statSync(seed.path).mtimeMs).toBe(modified);
    }
    const issues = await runLimina({
      fixtureName: 'disabled-cache-issues',
      cwd: f.root,
      entry: { executable: process.execPath, args: [cli] },
      args: [
        'check',
        '--issues',
        '--format',
        'json',
        '--config',
        f.path(f.entry),
      ],
      env: { NODE_OPTIONS: '' },
    });
    expect(issues.code, issues.stdout + issues.stderr).toBe(0);
    expect(() => JSON.parse(issues.stdout)).not.toThrow();
    expect(readFileSync(seed.path)).toEqual(bytes);
    expectCache(await check(f, loader), true);
  },
);

it.each([
  [{ cache: {} }, 'cache.dependencies'],
  [{ cache: { dependencies: [], force: true } }, 'cache.force'],
  [{ cache: { dependencies: [], enabled: false } }, 'cache.enabled'],
  [{ cache: { dependencies: ['*.json'] } }, 'cache.dependencies'],
  [{ cache: { dependencies: ['./'] } }, 'cache.dependencies'],
  [{ configDependencies: [] }, 'configDependencies has been removed'],
])(
  'rejects invalid public cache %j through the CLI',
  async (invalid, message) => {
    const f = fixture('mjs');
    f.write(f.entry, `export default ${JSON.stringify(invalid)};`);
    const result = await runLimina({
      fixtureName: 'invalid-cache-config',
      cwd: f.root,
      entry: { executable: process.execPath, args: [cli] },
      args: ['check', 'probe', '--config', f.path(f.entry)],
      env: { NODE_OPTIONS: '' },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message as string);
    expect(existsSync(f.path('.limina'))).toBe(false);
  },
);

it('forces one config namespace without changing another config or worktree snapshot', async () => {
  const f = fixture('mjs');
  const other = fixture('mjs');
  const otherSeed = await check(other, 'native');
  expectCache(await check(other, 'native'), true);
  const otherBytes = readFileSync(otherSeed.path);
  const otherTime = statSync(otherSeed.path).mtimeMs;
  const first = await check(f, 'native');
  expectCache(await check(f, 'native'), true);
  f.entry = 'second.config.mjs';
  f.write(
    f.entry,
    "import config from './helper.mjs'; export default {...config,cache:true};",
  );
  expect(
    count((await runProfile(f, 'native')).events, 'semanticPrograms'),
  ).toBeGreaterThan(0);
  expect(count((await runProfile(f, 'native')).events, 'graphHits')).toBe(1);
  const secondPath = readdirSync(f.path('.limina'), { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('snapshot.json'))
    .map((entry) => f.path('.limina', entry))
    .find((file) => file !== first.path)!;
  expect(secondPath).toBeDefined();
  const secondBytes = readFileSync(secondPath);
  const secondTime = statSync(secondPath).mtimeMs;
  f.entry = 'limina.config.mjs';
  expectCache(await check(f, 'native', { args: ['--force'] }), false);
  expect(readFileSync(secondPath)).toEqual(secondBytes);
  expect(statSync(secondPath).mtimeMs).toBe(secondTime);
  expect(readFileSync(otherSeed.path)).toEqual(otherBytes);
  expect(statSync(otherSeed.path).mtimeMs).toBe(otherTime);
  f.entry = 'second.config.mjs';
  expect(count((await runProfile(f, 'native')).events, 'graphHits')).toBe(1);
});

it('keeps a newer snapshot when a stale forced CLI writer resumes after its command', async () => {
  const f = fixture('mjs');
  f.write(
    'wait.mjs',
    `import {existsSync,writeFileSync} from 'node:fs';
if(process.env.PAUSE_CACHE_WRITER==='1'){
  writeFileSync('writer-ready','yes');
  await new Promise(resolve=>{const timer=setInterval(()=>{
    if(existsSync('writer-release')){clearInterval(timer);resolve();}
  },10);});
}`,
  );
  f.write(
    f.entry,
    `import config from './helper.mjs'; export default {...config,cache:true,pipelines:{probe:[
    'graph:check',${JSON.stringify({ type: 'command', command: process.execPath, args: [f.path('wait.mjs')] })},'graph:check'
  ]}};`,
  );
  const seed = await check(f, 'native');
  const old = readFileSync(seed.path);
  const stale = (async () => {
    try {
      return await runProfile(f, 'native', {
        args: ['--force'],
        env: { PAUSE_CACHE_WRITER: '1' },
      });
    } catch (error) {
      return { error };
    }
  })();
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(f.path('writer-ready'))) {
      if (Date.now() > deadline)
        throw new Error('Forced writer did not reach its command barrier.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const current = await check(f, 'native', { args: ['--force'] });
    expect(count(current.events, 'semanticPrograms')).toBeGreaterThan(0);
    const published = readFileSync(seed.path);
    const modified = statSync(seed.path).mtimeMs;
    expect(published).not.toEqual(old);
    f.write('writer-release', 'yes');
    expect(await stale).not.toHaveProperty('error');
    expect(readFileSync(seed.path)).toEqual(published);
    expect(statSync(seed.path).mtimeMs).toBe(modified);
    const restored = await check(f, 'native');
    expect(count(restored.events, 'semanticPrograms')).toBe(0);
    expect(count(restored.events, 'graphHits')).toBeGreaterThan(0);
  } finally {
    f.write('writer-release', 'yes');
    await stale;
  }
});

it('retains checker build information when analysis caching is disabled or forced', async () => {
  const f = fixture('mjs');
  f.write(
    'src/globals.d.ts',
    `
interface Array<T> { length: number; [index: number]: T }
interface Boolean {}
interface CallableFunction extends Function {}
interface Function {}
interface IArguments {}
interface NewableFunction extends Function {}
interface Number {}
interface Object {}
interface RegExp {}
interface String {}
`,
  );
  f.write(
    f.entry,
    `import config from './helper.mjs'; export default {...config,
    cache:process.env.DISABLE_CACHE==='1'?false:true,
    pipelines:{probe:['graph:check','checker:build']}
  };`,
  );
  const seed = await check(f, 'native');
  const warm = await check(f, 'native');
  expect(count(warm.events, 'semanticPrograms')).toBe(0);
  expect(count(warm.events, 'graphHits')).toBeGreaterThan(0);
  const buildInfo = readdirSync(f.root, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('.tsbuildinfo'))
    .map((entry) => ({
      file: f.path(entry),
      bytes: readFileSync(f.path(entry)),
      modified: statSync(f.path(entry)).mtimeMs,
    }));
  expect(buildInfo.length).toBeGreaterThan(0);
  const snapshot = readFileSync(seed.path);
  const modified = statSync(seed.path).mtimeMs;
  for (const isDisabled of [false, true]) {
    const profile = await runProfile(f, 'native', {
      args: ['--force'],
      env: { DISABLE_CACHE: isDisabled ? '1' : '0' },
    });
    for (const record of buildInfo) {
      expect(readFileSync(record.file)).toEqual(record.bytes);
      expect(statSync(record.file).mtimeMs).toBe(record.modified);
    }
    if (isDisabled) {
      expect(
        profile.events.some((event) => event.name === 'analysis-cache'),
      ).toBe(false);
    } else {
      expect(count(profile.events, 'semanticPrograms')).toBeGreaterThan(0);
    }
  }
  expect(readFileSync(seed.path)).not.toEqual(snapshot);
  expect(statSync(seed.path).mtimeMs).not.toBe(modified);
});
