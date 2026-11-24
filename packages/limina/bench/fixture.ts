import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
Shape of a generated pnpm workspace. Package `i` depends on up to
`fanIn` earlier packages, so the reference graph is a layered DAG.
*/
export interface WorkspaceShape {
  readonly fanIn: number;
  readonly modulesPerPackage: number;
  readonly packages: number;
}

export interface BenchWorkspace {
  readonly configPath: string;
  readonly rootDir: string;
  dispose(): Promise<void>;
}

// `noLib` keeps the default library files out of every bounded program, so the
// measurement stays on Limina's own analysis rather than on parsing lib.d.ts.
const compilerOptions = {
  module: 'ESNext',
  moduleResolution: 'Bundler',
  noEmit: true,
  strict: true,
  target: 'ES2023',
  noLib: true,
  types: [],
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function packageName(index: number): string {
  return `@bench/pkg-${String(index).padStart(3, '0')}`;
}

function packageSlug(index: number): string {
  return `pkg-${String(index).padStart(3, '0')}`;
}

function packageDirectory(index: number): string {
  return `packages/${packageSlug(index)}`;
}

function dependenciesOf(index: number, shape: WorkspaceShape): number[] {
  const dependencies: number[] = [];
  for (let offset = 1; offset <= shape.fanIn && offset <= index; offset++)
    dependencies.push(index - offset);
  return dependencies;
}

function moduleSource(
  index: number,
  moduleIndex: number,
  dependencies: readonly number[],
): string {
  const lines: string[] = [];
  if (moduleIndex === 0) {
    for (const dependency of dependencies)
      lines.push(
        `import { value as dep${dependency} } from '${packageName(dependency)}';`,
      );
  } else {
    lines.push(
      `import { value as previous } from './module-${moduleIndex - 1}';`,
    );
  }
  lines.push(
    `export interface Shape${moduleIndex} { readonly id: number; readonly label: string }`,
  );
  const terms =
    moduleIndex === 0
      ? ['1', ...dependencies.map((dependency) => `dep${dependency}`)]
      : ['previous', String(moduleIndex)];
  lines.push(
    `export const value: number = ${terms.join(' + ')};`,
    `export function make${moduleIndex}(label: string): Shape${moduleIndex} {`,
    `  return { id: value + ${index}, label };`,
    '}',
  );
  return `${lines.join('\n')}\n`;
}

function packageFiles(
  index: number,
  shape: WorkspaceShape,
): Record<string, string> {
  const directory = packageDirectory(index);
  const dependencies = dependenciesOf(index, shape);
  const last = shape.modulesPerPackage - 1;
  const files: Record<string, string> = {
    [`${directory}/package.json`]: json({
      name: packageName(index),
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      dependencies: Object.fromEntries(
        dependencies.map((dependency) => [
          packageName(dependency),
          'workspace:*',
        ]),
      ),
    }),
    [`${directory}/src/index.ts`]: `export { value } from './module-${last}';\nexport * from './module-0';\n`,
    [`${directory}/test/index.test.ts`]: `import { value } from '../src/index';\nexport const checked: number = value;\n`,
    [`${directory}/tsconfig.json`]: json({
      files: [],
      references: [
        { path: './tsconfig.lib.json' },
        { path: './tsconfig.test.json' },
      ],
    }),
    [`${directory}/tsconfig.lib.json`]: json({
      compilerOptions: { ...compilerOptions, rootDir: 'src' },
      include: ['src/**/*.ts'],
    }),
    [`${directory}/tsconfig.test.json`]: json({
      compilerOptions: { ...compilerOptions, rootDir: '.' },
      include: ['test/**/*.ts'],
    }),
  };
  for (let moduleIndex = 0; moduleIndex <= last; moduleIndex++)
    files[`${directory}/src/module-${moduleIndex}.ts`] = moduleSource(
      index,
      moduleIndex,
      dependencies,
    );
  return files;
}

async function writeText(filePath: string, text: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

/**
Writes a pnpm workspace with tsc-only Limina configuration into a fresh
temporary directory, including the `node_modules` links pnpm would create.
*/
export async function createBenchWorkspace(
  shape: WorkspaceShape,
): Promise<BenchWorkspace> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'limina-bench-'),
  );
  const rootDirectory = await realpath(temporaryDirectory);
  const files: Record<string, string> = {
    'package.json': json({ name: 'bench-root', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'limina.config.mjs': `export default ${JSON.stringify({
      scope: { checkers: { tsc: { include: ['tsconfig.json'] } } },
    })};\n`,
    'tsconfig.json': json({
      files: [],
      references: Array.from({ length: shape.packages }, (_, index) => ({
        path: `./${packageDirectory(index)}/tsconfig.json`,
      })),
    }),
  };
  for (let index = 0; index < shape.packages; index++)
    Object.assign(files, packageFiles(index, shape));
  for (const [relativePath, text] of Object.entries(files))
    await writeText(path.join(rootDirectory, relativePath), text);
  for (let index = 0; index < shape.packages; index++) {
    const scopeDirectory = path.join(
      rootDirectory,
      packageDirectory(index),
      'node_modules/@bench',
    );
    await mkdir(scopeDirectory, { recursive: true });
    for (const dependency of dependenciesOf(index, shape)) {
      const target = path.join(rootDirectory, packageDirectory(dependency));
      await symlink(
        path.relative(scopeDirectory, target),
        path.join(scopeDirectory, packageSlug(dependency)),
        'junction',
      );
    }
  }
  return {
    configPath: path.join(rootDirectory, 'limina.config.mjs'),
    rootDir: rootDirectory,
    dispose: () => rm(rootDirectory, { force: true, recursive: true }),
  };
}
