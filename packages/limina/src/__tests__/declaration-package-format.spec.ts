import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { EpochInputs } from '../core/analysis-cache/epoch-inputs';
import {
  declarationPackageFiles,
  validateDeclarationPackageFormat,
} from '../core/build-graph/declaration-package-format';
import { withVirtualResolutionFiles } from '../core/typescript-semantic/virtual-resolution-host';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

async function fixture() {
  const f = await createSemanticRepairFixture({
    'package.json': '{"private":true,"type":"module"}',
    'src/top.ts': 'export const top: number = 1;',
    'src/nested/value.ts': 'export const value: number = 2;',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        rootDir: 'src',
        outDir: '.limina/dts',
        declaration: true,
        emitDeclarationOnly: true,
        types: [],
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  });
  const parsed = f.parse();
  const epoch = new EpochInputs();
  const output = f.path('.limina/dts/nested/value.d.ts');
  const nestedPackage = f.path('.limina/dts/nested/package.json');
  const files = declarationPackageFiles({
    sourceConfig: f.path('tsconfig.json'),
    parsed,
  });
  const observe = () =>
    epoch.run(() =>
      validateDeclarationPackageFormat({
        sourceConfig: f.path('tsconfig.json'),
        sourceFile: f.path('src/nested/value.ts'),
        outputFile: output,
        files,
      }),
    );
  const emit = async () => {
    for (const [file, content] of files) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
    });
    expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
    expect(program.emit().emitSkipped).toBe(false);
    expect(ts.sys.fileExists(output)).toBe(true);
  };
  return { ...f, epoch, files, output, nestedPackage, observe, emit };
}

it('exposes planned directories without inventing files or contents', async () => {
  const f = await fixture();
  try {
    const host = withVirtualResolutionFiles(ts.sys, undefined, [f.output]);
    expect(ts.sys.directoryExists(f.path('.limina/dts/nested'))).toBe(false);
    expect(host.directoryExists!(f.path('.limina/dts/nested'))).toBe(true);
    expect(host.fileExists(f.output)).toBe(false);
    expect(host.readFile(f.output)).toBeUndefined();
    expect(host.directoryExists!(f.path('.limina/unplanned'))).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it.each(['live', 'restored'] as const)(
  'keeps %s format evidence stable across declaration emission',
  async (mode) => {
    const f = await fixture();
    try {
      expect(f.files.keys().toArray()).toEqual([
        f.path('.limina/dts/package.json'),
      ]);
      f.observe();
      const epoch = mode === 'live' ? f.epoch : new EpochInputs();
      if (mode === 'restored')
        expect(await epoch.validate(f.epoch.snapshot()!)).toBe(true);
      await f.emit();
      await expect(epoch.assertStable()).resolves.toBeUndefined();
    } finally {
      await f.cleanup();
    }
  },
);

it('rejects a physical nested output package that changes module format', async () => {
  const f = await fixture();
  try {
    await mkdir(path.dirname(f.nestedPackage), { recursive: true });
    await writeFile(f.nestedPackage, '{"type":"commonjs"}');
    expect(f.observe).toThrow(
      'Compiler reference output changes package format',
    );
  } finally {
    await f.cleanup();
  }
});

it.each(['source-package', 'new-output-package', 'symlink'] as const)(
  'retains real input drift protection: %s',
  async (change) => {
    const f = await fixture();
    try {
      if (change === 'symlink') {
        await mkdir(f.path('target-a'));
        await mkdir(f.path('target-b'));
        await mkdir(f.path('.limina/dts'), { recursive: true });
        await symlink(
          f.path('target-a'),
          f.path('.limina/dts/nested'),
          'junction',
        );
      }
      f.observe();
      await f.emit();
      if (change === 'symlink') {
        await rm(f.path('.limina/dts/nested'));
        await symlink(
          f.path('target-b'),
          f.path('.limina/dts/nested'),
          'junction',
        );
      } else
        await writeFile(
          change === 'source-package'
            ? f.path('package.json')
            : f.nestedPackage,
          '{"type":"commonjs"}',
        );
      await expect(f.epoch.assertStable()).rejects.toThrow(
        'Analysis input changed during analysis',
      );
    } finally {
      await f.cleanup();
    }
  },
);
