import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

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
      !['INIT_CWD', 'NODE_PATH'].includes(key),
  ),
);
environment.PATH = (process.env.PATH ?? '')
  .split(path.delimiter)
  .filter((entry) => !entry.includes(`${path.sep}node_modules${path.sep}`))
  .join(path.delimiter);

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

await mkdir(path.join(workspace, 'node_modules/.bin'), { recursive: true });
for (const [name, target] of [
  ['limina', 'packages/limina/dist'],
  ['typescript', 'node_modules/typescript'],
  ['publint', 'packages/limina/node_modules/publint'],
  [
    '@arethetypeswrong/core',
    'packages/limina/node_modules/@arethetypeswrong/core',
  ],
] as const) {
  const link = path.join(workspace, 'node_modules', name);
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(path.join(repo, target), link, 'dir');
}
for (const [name, target] of [
  ['limina', '../limina/bin/limina.js'],
  ['tsc', '../typescript/bin/tsc'],
] as const)
  await symlink(target, path.join(workspace, 'node_modules/.bin', name));
if (pnpmExecutable !== 'pnpm')
  await symlink(pnpmExecutable, path.join(workspace, 'node_modules/.bin/pnpm'));
await mkdir(path.join(workspace, 'packages/app/node_modules/@repo'), {
  recursive: true,
});
await symlink(
  path.join(workspace, 'packages/core'),
  path.join(workspace, 'packages/app/node_modules/@repo/core'),
  'dir',
);

async function run(
  id: string,
  arguments_: string[],
  expectedExitCode = 0,
  directory = '.',
) {
  const logPath = path.join(workspace, `${id}.log`);
  const log = await open(logPath, 'w');
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      // One file descriptor preserves stdout/stderr ordering, including child tools.
      const child = spawn(
        process.execPath,
        [
          path.join(workspace, 'node_modules/limina/bin/limina.js'),
          ...arguments_,
        ],
        {
          cwd: path.join(workspace, directory),
          env: {
            ...environment,
            PATH:
              path.join(workspace, 'node_modules/.bin') +
              path.delimiter +
              environment.PATH,
            CI: '1',
            NO_COLOR: '1',
            FORCE_COLOR: '0',
            TERM: 'dumb',
          },
          stdio: ['ignore', log.fd, log.fd],
        },
      );
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    await log.close();
  }
  const raw = await readFile(logPath, 'utf8');
  if (exitCode !== expectedExitCode)
    throw new Error(
      `${id}: expected exit ${expectedExitCode}, received ${exitCode}\n${raw}`,
    );
  // Strip only terminal control sequences. Retain every printed line and space.
  const text = stripVTControlCharacters(raw);
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  return {
    id,
    command: `limina ${arguments_.join(' ')}`,
    workspace:
      directory === '.' ? 'limina-workspace' : `limina-workspace/${directory}`,
    exitCode,
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
    environment: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
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
await writeFile(output, JSON.stringify(data, null, 2) + '\n');
