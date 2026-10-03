import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { terminalFrames, type TerminalChunk } from './terminal-frames';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const workspace = path.resolve(process.argv[2] ?? '');
const output = path.resolve(
  process.argv[3] ??
    path.join(repo, 'docs/.vitepress/theme/command-transcripts.json'),
);
const pnpmExecutable = process.argv[4] ? path.resolve(process.argv[4]) : 'pnpm';
// Nested package-manager invocations must not inherit the parent workspace's bins.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(?:npm_|PNPM_|VP_)/.test(key) &&
      ![
        'INIT_CWD',
        'NODE_PATH',
        'NODE_OPTIONS',
        'CI',
        'CODEX_CI',
        'NO_COLOR',
        'FORCE_COLOR',
        'pnpm_config_verify_deps_before_run',
      ].includes(key),
  ),
);
environment.PATH = [
  path.dirname(process.execPath),
  ...(process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => !entry.includes(`${path.sep}node_modules${path.sep}`)),
].join(path.delimiter);
environment.TERM = 'xterm-256color';

if (!process.argv[2]) {
  throw new Error(
    'Usage: pnpm exec tsx scripts/docs/capture-command-transcripts.ts <new-workspace> [output.json] [pnpm-executable]',
  );
}

// Refuse an existing workspace so regeneration cannot overwrite other work.
await mkdir(workspace);

async function write(relative: string, content: string | object) {
  const target = path.join(workspace, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    typeof content === 'string'
      ? content
      : JSON.stringify(content, null, 2) + '\n',
  );
}

const typescript = JSON.parse(
  await readFile(
    path.join(repo, 'node_modules/typescript/package.json'),
    'utf8',
  ),
) as { version: string };
const limina = JSON.parse(
  await readFile(path.join(repo, 'packages/limina/dist/package.json'), 'utf8'),
) as { version: string };
const pnpm = execFileSync(pnpmExecutable, ['--version'], {
  encoding: 'utf8',
  env: environment,
}).trim();
if (pnpm !== '11.28.3')
  throw new Error(`Expected pnpm 11.28.3, received ${pnpm}`);

await write('package.json', {
  name: 'limina-workspace',
  private: true,
  type: 'module',
  packageManager: 'pnpm@11.28.3',
  scripts: { build: 'pnpm --dir packages/core run build' },
  devDependencies: {
    limina: `link:${path.join(repo, 'packages/limina/dist')}`,
    typescript: `link:${path.join(repo, 'node_modules/typescript')}`,
    publint: `link:${path.join(repo, 'packages/limina/node_modules/publint')}`,
    '@arethetypeswrong/core': `link:${path.join(repo, 'packages/limina/node_modules/@arethetypeswrong/core')}`,
  },
});
await write(
  'pnpm-workspace.yaml',
  "packages:\n  - 'packages/*'\nautoInstallPeers: false\n",
);
await write('tsconfig.json', {
  files: [],
  references: [{ path: 'packages/core' }, { path: 'packages/app' }],
});
await write(
  'limina.config.mjs',
  `export default {
  config: { checkers: { tsc: { include: ['tsconfig.json'] } } },
  source: { knip: false },
  package: { entries: [{ name: '@repo/core', outDir: 'packages/core/dist' }] },
  pipelines: { release: [{ type: 'command', command: 'pnpm', args: ['build'] }, 'package:check', 'release:check'] },
};
`,
);
for (const name of ['core', 'app']) {
  await write(`packages/${name}/package.json`, {
    name: `@repo/${name}`,
    version: '1.0.0',
    type: 'module',
    license: 'MIT',
    ...(name === 'app' && {
      private: true,
      dependencies: { '@repo/core': 'workspace:*' },
    }),
    files: ['dist'],
    ...(name === 'core' && {
      scripts: { build: 'tsc -b && node build.mjs' },
      sideEffects: false,
    }),
    ...(name === 'core' && {
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      },
    }),
  });
  await write(`packages/${name}/tsconfig.json`, {
    compilerOptions: {
      composite: true,
      declaration: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      target: 'ES2022',
      types: [],
      ...(name === 'app' && {
        paths: { '@repo/core': ['../core/src/index.ts'] },
      }),
    },
    include: ['src/**/*.ts'],
  });
}
await write('packages/core/src/index.ts', 'export const value = 1;\n');
await write(
  'packages/core/README.md',
  '# @repo/core\n\nExports a numeric value for the workspace application.\n',
);
await write(
  'packages/core/LICENSE.md',
  await readFile(path.join(repo, 'LICENSE'), 'utf8'),
);
await write(
  'packages/core/build.mjs',
  String.raw`import { copyFile, readFile, writeFile } from 'node:fs/promises';
const { scripts, ...manifest } = JSON.parse(await readFile('package.json', 'utf8'));
manifest.files = ['*.js', '*.d.ts'];
manifest.exports = { '.': { types: './index.d.ts', import: './index.js' } };
await writeFile('dist/package.json', JSON.stringify(manifest, null, 2) + '\n');
await copyFile('README.md', 'dist/README.md');
await copyFile('LICENSE.md', 'dist/LICENSE.md');
`,
);
const appSource =
  "import { value } from '@repo/core';\nexport const result = value + 1;\n";
await write('packages/app/src/index.ts', appSource);

if (pnpmExecutable !== 'pnpm') {
  const bin = path.join(workspace, '.capture-bin');
  await mkdir(bin);
  await symlink(pnpmExecutable, path.join(bin, 'pnpm'));
  environment.PATH = bin + path.delimiter + environment.PATH;
}
// Let pnpm create its normal lockfile, workspace links and executable shims.
// Keep its default dependency verification enabled, including nested scripts.
for (const [id, arguments_] of [
  ['install-lockfile', ['install', '--lockfile-only', '--offline']],
  ['install-frozen', ['install', '--frozen-lockfile', '--offline']],
] as const) {
  const log = execFileSync('pnpm', arguments_, {
    cwd: workspace,
    env: environment,
    encoding: 'utf8',
  });
  await write(`${id}.log`, log);
}
const installedNode = execFileSync('pnpm', ['exec', 'node', '--version'], {
  cwd: workspace,
  env: environment,
  encoding: 'utf8',
}).trim();
if (installedNode !== process.version)
  throw new Error(`Expected ${process.version}, received ${installedNode}`);
const columns = 100;
const rows = 80;

async function run(
  id: string,
  arguments_: string[],
  expectedExitCode = 0,
  directory = '.',
) {
  const argv = ['pnpm', 'exec', 'limina', ...arguments_];
  const cwd = path.join(workspace, directory);
  const capturePath = path.join(workspace, `${id}.capture.json`);
  execFileSync(
    'python3',
    [
      path.join(repo, 'scripts/docs/capture-terminal.py'),
      '--columns',
      String(columns),
      '--rows',
      String(rows),
      cwd,
      capturePath,
      '--',
      ...argv,
    ],
    { env: environment, timeout: 60_000 },
  );
  const { exitCode, chunks } = JSON.parse(
    await readFile(capturePath, 'utf8'),
  ) as { exitCode: number; chunks: TerminalChunk[] };
  const raw = chunks.map((chunk) => chunk.text).join('');
  await write(`${id}.log`, raw);
  if (exitCode !== expectedExitCode)
    throw new Error(
      `${id}: expected exit ${expectedExitCode}, received ${exitCode}\n${raw}`,
    );
  const frames = await terminalFrames(chunks, columns, rows);
  if (frames.length === 0)
    throw new Error(`${id}: no terminal output captured`);
  const lines = frames.at(-1)!.lines;
  return {
    id,
    command: argv.join(' '),
    argv,
    cwd,
    workspace:
      directory === '.' ? 'limina-workspace' : `limina-workspace/${directory}`,
    exitCode,
    rawSha256: createHash('sha256').update(raw).digest('hex'),
    frames,
    lines,
  };
}

const commands: Record<string, Awaited<ReturnType<typeof run>>> = {};
for (const [id, arguments_] of [
  ['prepare', ['graph', 'prepare']],
  ['build', ['checker', 'build']],
  ['incremental', ['checker', 'build']],
  ['graph', ['graph', 'check']],
  ['source', ['source', 'check']],
  ['proof', ['proof', 'check']],
  ['check', ['check']],
] as const)
  commands[id] = await run(id, [...arguments_]);
commands.pipeline = await run(
  'pipeline',
  ['check', 'release'],
  0,
  'packages/core',
);
await write(
  'packages/app/src/index.ts',
  "import { value } from '../../core/src/index.js';\nexport const result = value + 1;\n",
);
commands.boundary = await run('boundary', ['source', 'check'], 1);
await write('packages/app/src/index.ts', appSource);

async function hashFiles(directory: string, hash = createHash('sha256')) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await hashFiles(target, hash);
    else {
      hash.update(path.relative(repo, target).split(path.sep).join('/'));
      hash.update(await readFile(target));
    }
  }
  return hash;
}
const data = {
  capture: {
    node: process.version,
    pnpm,
    typescript: typescript.version,
    limina: limina.version,
    platform: `${process.platform}-${process.arch}`,
    mode: 'interactive',
    terminal: { columns, rows },
    environment: {
      CI: null,
      CODEX_CI: null,
      NO_COLOR: null,
      FORCE_COLOR: null,
      TERM: environment.TERM,
      verifyDepsBeforeRun: 'default',
    },
    sourceSha256: (
      await hashFiles(path.join(repo, 'packages/limina/src'))
    ).digest('hex'),
    cliSha256: createHash('sha256')
      .update(await readFile(path.join(repo, 'packages/limina/dist/cli.js')))
      .digest('hex'),
  },
  commands,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, await format(JSON.stringify(data), { parser: 'json' }));
