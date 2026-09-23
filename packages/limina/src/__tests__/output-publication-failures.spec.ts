import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import {
  copyOutputDeclarationInputs,
  createOutputDeclarationCopyPlan,
} from '../typecheck/output-declarations';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const fault = vi.hoisted(() => ({ kind: '', target: '', directory: '' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (fault.kind === 'directory' && String(args[0]) === fault.directory) {
        throw new Error('injected directory failure');
      }
      return actual.mkdir(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] !== 'wx+' || String(args[0]) !== fault.target) return handle;
      const write = handle.writeFile.bind(handle);
      if (fault.kind === 'partial') {
        handle.writeFile = async () => {
          await write('export');
          throw new Error('injected partial failure');
        };
      }
      if (fault.kind === 'sync') {
        handle.sync = async () => {
          throw new Error('injected sync failure');
        };
      }
      if (fault.kind === 'readback') {
        handle.read = async () => {
          throw new Error('injected readback failure');
        };
      }
      if (fault.kind === 'replacement') {
        handle.sync = async () => {
          await actual.rename(fault.target, `${fault.target}.original`);
          await actual.writeFile(fault.target, 'user replacement');
          throw new Error('injected replacement');
        };
      }
      return handle;
    },
  };
});

it.each(['partial', 'sync', 'readback', 'directory'])(
  'rolls back transaction-owned paths after %s failure and permits retry',
  async (kind) => {
    const fixture = await createSemanticRepairFixture({
      'package.json': '{}',
      'src/nested/deeper/env.d.ts': 'export declare const value: number;\n',
      'dist/user.txt': 'keep',
    });
    const plan = createOutputDeclarationCopyPlan({
      fileNames: [fixture.path('src/nested/deeper/env.d.ts')],
      outDir: fixture.path('dist'),
      rootDir: fixture.path('src'),
      projectRootDir: fixture.root,
    });
    fault.kind = kind;
    fault.target = fixture.path('dist/nested/deeper/env.d.ts');
    fault.directory = fixture.path('dist/nested/deeper');
    try {
      await expect(
        copyOutputDeclarationInputs(plan, { projectRootDir: fixture.root }),
      ).rejects.toThrow(`injected ${kind}`);
      expect(existsSync(fault.target)).toBe(false);
      expect(existsSync(fixture.path('dist/nested'))).toBe(false);
      expect(await readFile(fixture.path('dist/user.txt'), 'utf8')).toBe(
        'keep',
      );
      fault.kind = '';
      await copyOutputDeclarationInputs(plan, { projectRootDir: fixture.root });
      expect(await readFile(fault.target, 'utf8')).toBe(
        'export declare const value: number;\n',
      );
    } finally {
      fault.kind = '';
      await fixture.cleanup();
    }
  },
);

it('preserves a replacement file when an unverified publication fails', async () => {
  const fixture = await createSemanticRepairFixture({
    'package.json': '{}',
    'src/env.d.ts': 'export declare const value: number;',
  });
  await mkdir(fixture.path('dist'));
  await writeFile(fixture.path('dist/user.txt'), 'keep');
  const plan = createOutputDeclarationCopyPlan({
    fileNames: [fixture.path('src/env.d.ts')],
    outDir: fixture.path('dist'),
    rootDir: fixture.path('src'),
    projectRootDir: fixture.root,
  });
  fault.kind = 'replacement';
  fault.target = fixture.path('dist/env.d.ts');
  try {
    await expect(
      copyOutputDeclarationInputs(plan, { projectRootDir: fixture.root }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(await readFile(fault.target, 'utf8')).toBe('user replacement');
  } finally {
    fault.kind = '';
    await fixture.cleanup();
  }
});
