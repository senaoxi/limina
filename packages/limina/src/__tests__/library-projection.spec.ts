import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { LiminaPreflightManager } from '../preflight';
import { runCheckerBuildImpl } from '../typecheck/checker/build-runner';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createFixturePathResolver } from './helpers/path';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(options: Record<string, unknown> = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'limina-libraries-'));
  const root = realpathSync.native(temporary);
  roots.push(root);
  const file = createFixturePathResolver(root);
  const write = (name: string, value: unknown) => {
    mkdirSync(path.dirname(file(name)), { recursive: true });
    writeFileSync(
      file(name),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  write('package.json', {
    name: 'fixture',
    private: true,
    packageManager: 'pnpm@12.10.1',
  });
  write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  write(
    'limina.config.mjs',
    'export default {scope:{checkers:{tsc:{include:["tsconfig.json"]}}}};',
  );
  write('tsconfig.json', { files: [], references: [{ path: './packages/a' }] });
  write('packages/a/package.json', { name: '@example/a', private: true });
  write('packages/a/tsconfig.json', {
    files: ['a.ts'],
    compilerOptions: {
      target: 'ES2023',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      types: [],
      lib: ['ES2023', 'DOM'],
      libReplacement: true,
      strict: true,
      noEmit: true,
      ...options,
    },
  });
  write('packages/a/a.ts', 'export const value = projectLibraryValue;');
  const config = withFixtureGovernanceRoot({
    rootDir: root,
    configPath: file('limina.config.mjs'),
    scope: { checkers: { tsc: { include: ['tsconfig.json'] } } },
  });
  return { root, file, write, config };
}

type Fixture = ReturnType<typeof fixture>;
function replacement(
  input: Fixture,
  directory: string,
  value: string,
  library = 'dom',
) {
  const folder = `${directory}/node_modules/@typescript/lib-${library}`;
  input.write(`${folder}/package.json`, {
    name: `@typescript/lib-${library}`,
    version: '1.0.0',
    types: 'index.d.ts',
  });
  input.write(
    `${folder}/index.d.ts`,
    `/// <reference lib="es2020" />\ndeclare const projectLibraryValue: "${value}";`,
  );
  return input.file(`${folder}/index.d.ts`);
}

function program(config: string) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    config,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        throw new Error('Invalid fixture config');
      },
    },
  )!;
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
}

async function build(input: Fixture, manager: LiminaPreflightManager) {
  const result = await runCheckerBuildImpl({
    config: input.config,
    preflight: manager,
    cwd: input.root,
    clearScreen: false,
    report: { defer: true },
  });
  expect(result.passed).toBe(true);
  const graph = await manager.ensureGeneratedGraph();
  const generated = graph.sourceToDts
    .get('tsc')!
    .get(input.file('packages/a/tsconfig.json'))!;
  const compiled = program(generated);
  expect(ts.getPreEmitDiagnostics(compiled)).toEqual([]);
  const declaration = path.join(
    compiled.getCompilerOptions().outDir!,
    'a.d.ts',
  );
  return { graph, compiled, declaration: readFileSync(declaration, 'utf8') };
}

it.each(['explicit', 'implicit', 'directive'] as const)(
  'preserves compiler library selection for %s entries in real declaration builds',
  async (entry) => {
    const input = fixture(
      entry === 'implicit'
        ? { lib: undefined }
        : entry === 'directive'
          ? { lib: ['ES2023'] }
          : {},
    );
    const library = entry === 'implicit' ? 'es2023' : 'dom';
    const target = replacement(input, 'packages/a', 'local', library);
    if (entry !== 'explicit') replacement(input, '.', 'workspace', library);
    if (entry === 'directive')
      input.write(
        'packages/a/a.ts',
        '/// <reference lib="dom" />\nexport const value = projectLibraryValue;',
      );
    const source = program(input.file('packages/a/tsconfig.json'));
    expect(ts.getPreEmitDiagnostics(source)).toEqual([]);
    const manager = new LiminaPreflightManager({ config: input.config });
    try {
      const result = await build(input, manager);
      expect(result.declaration).toContain('"local"');
      expect(result.compiled.getCompilerOptions().libReplacement).toBe(true);
      expect(
        result.compiled.isSourceFileDefaultLibrary(
          result.compiled.getSourceFile(target)!,
        ),
      ).toBe(true);
      expect(result.graph.dependencyEdges).toEqual([]);
    } finally {
      manager.dispose();
    }
  },
);

it('retains skipDefaultLibCheck on the original replacement declaration', async () => {
  const input = fixture({ skipDefaultLibCheck: true });
  const target = replacement(input, 'packages/a', 'local');
  input.write(
    path.relative(input.root, target),
    'declare const projectLibraryValue: "local"; declare const invalid: MissingLibraryType;',
  );
  const source = program(input.file('packages/a/tsconfig.json'));
  expect(ts.getPreEmitDiagnostics(source)).toEqual([]);
  const manager = new LiminaPreflightManager({ config: input.config });
  try {
    expect((await build(input, manager)).declaration).toContain('"local"');
  } finally {
    manager.dispose();
  }
});

it('preserves an explicit libReplacement=false without introducing replacement types', async () => {
  const input = fixture({ libReplacement: false });
  replacement(input, 'packages/a', 'local');
  input.write('packages/a/a.ts', 'export const value = document;');
  const manager = new LiminaPreflightManager({ config: input.config });
  try {
    const result = await build(input, manager);
    expect(result.declaration).toContain('Document');
    expect(result.compiled.getCompilerOptions().libReplacement).toBe(false);
  } finally {
    manager.dispose();
  }
});

interface CachedResult {
  hit: boolean;
  generated: string;
  files: string[];
}

it('preserves replacement identity when an output target activates a different default library', async () => {
  const input = fixture({ lib: undefined });
  replacement(input, 'packages/a', 'local', 'es2022');
  replacement(input, '.', 'workspace', 'es2022');
  const sourcePath = input.file('packages/a/tsconfig.json');
  const sourceConfig = JSON.parse(readFileSync(sourcePath, 'utf8'));
  sourceConfig.liminaOptions = {
    outputs: { target: 'ES2022', outDir: 'dist' },
  };
  input.write('packages/a/tsconfig.json', sourceConfig);
  const manager = new LiminaPreflightManager({ config: input.config });
  try {
    await manager.ensureGeneratedArtifactsMaterialized();
    const graph = await manager.ensureGeneratedGraph();
    const output = graph.configToOutputBuild.get('tsc')!.get(sourcePath)!.path;
    await execute(
      process.execPath,
      [
        require.resolve('typescript/bin/tsc'),
        '-b',
        output,
        '--pretty',
        'false',
      ],
      { cwd: input.root },
    );
    expect(
      readFileSync(input.file('packages/a/dist/a.d.ts'), 'utf8'),
    ).toContain('"local"');
    expect(program(output).getCompilerOptions().target).toBe(
      ts.ScriptTarget.ES2022,
    );
    expect(program(sourcePath).getCompilerOptions().target).toBe(
      ts.ScriptTarget.ES2023,
    );
  } finally {
    manager.dispose();
  }
});
async function cached(input: Fixture): Promise<CachedResult> {
  const url = (name: string) => new URL(`../${name}.ts`, import.meta.url).href;
  input.write(
    'cache-runner.mjs',
    `
import {loadConfig} from ${JSON.stringify(url('config/loader'))};
import {LiminaPreflightManager} from ${JSON.stringify(url('preflight/manager'))};
const events=[];
const config=await loadConfig({configPath:${JSON.stringify(input.file('limina.config.mjs'))}});
const manager=new LiminaPreflightManager({config,analysisCache:true,metrics:{record:e=>events.push(e)}});
try {
  await manager.ensureGeneratedArtifactsMaterialized();
  const graph=await manager.ensureGeneratedGraph();
  await manager.publishAnalysisCache();
  console.log(JSON.stringify({hit:events.some(e=>e.name==='analysis-cache'&&e.kind==='graphHits'&&e.count===1),generated:graph.sourceToDts.get('tsc').get(${JSON.stringify(input.file('packages/a/tsconfig.json'))}),files:[...graph.generatedFiles.keys()]}));
}finally{manager.dispose();}`,
  );
  const result = await execute(
    process.execPath,
    [
      '--import',
      pathToFileURL(require.resolve('tsx')).href,
      input.file('cache-runner.mjs'),
    ],
    { cwd: input.root, env: { ...process.env, TSX_DISABLE_CACHE: '1' } },
  );
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}

it('restores library bindings across processes and invalidates a new higher-priority replacement', async () => {
  const input = fixture();
  const first = replacement(input, '.', 'workspace');
  const cold = await cached(input);
  expect(program(cold.generated).getSourceFile(first)).toBeDefined();
  expect((await cached(input)).hit).toBe(true);
  const second = replacement(input, 'packages/a', 'local');
  const changed = await cached(input);
  expect(changed.hit).toBe(false);
  expect(program(changed.generated).getSourceFile(second)).toBeDefined();
  expect(program(changed.generated).getSourceFile(first)).toBeUndefined();
  expect((await cached(input)).hit).toBe(true);
});

it('refuses a modified library forwarding manifest before launching the Checker', async () => {
  const input = fixture();
  replacement(input, 'packages/a', 'local');
  const other = replacement(input, '.', 'workspace');
  const manager = new LiminaPreflightManager({ config: input.config });
  try {
    await manager.ensureGeneratedArtifactsMaterialized();
    const graph = await manager.ensureGeneratedGraph();
    const manifest = graph.generatedFiles
      .keys()
      .find((file) =>
        file.endsWith('/node_modules/@typescript/lib-dom/package.json'),
      )!;
    expect(manifest).toBeDefined();
    writeFileSync(manifest, JSON.stringify({ types: other }));
    const result = await runCheckerBuildImpl({
      config: input.config,
      preflight: manager,
      cwd: input.root,
      clearScreen: false,
      report: { defer: true },
    });
    expect(result.passed).toBe(false);
    expect(result.failureKind).toBe('execution-admission');
    expect(result.targetResults).toEqual([]);
  } finally {
    manager.dispose();
  }
});
