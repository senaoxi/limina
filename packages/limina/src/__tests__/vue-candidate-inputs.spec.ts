import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { DeclarationObservationUnavailable } from '../core/declaration-governance/candidate';
import { observeVueDeclarationCandidate } from '../core/vue-semantic/declaration-candidate';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

it.each(['utf8', 'utf16le', 'utf16be'] as const)(
  'rejects changed %s declaration bytes at the Vue candidate handoff',
  async (encoding) => {
    const f = await createSemanticRepairFixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noLib: true,
          types: [],
        },
        files: ['entry.d.ts'],
      }),
    });
    const require = createRequire(import.meta.url);
    const config = f.path('tsconfig.json');
    const declaration = f.path('entry.d.ts');
    const writeDeclaration = (marker: '裿' | '觿') => {
      const source = 'export interface API { value: number; } // ';
      if (encoding === 'utf8') {
        const byte = marker === '裿' ? 0x80 : 0x81;
        writeFileSync(
          declaration,
          Buffer.concat([Buffer.from(source), Buffer.from([byte])]),
        );
      } else {
        const bytes = Buffer.from(`\u{FEFF}${source}${marker}`, 'utf16le');
        writeFileSync(
          declaration,
          encoding === 'utf16be' ? bytes.swap16() : bytes,
        );
      }
    };
    try {
      await mkdir(f.path('node_modules'), { recursive: true });
      for (const name of ['vue-tsc', 'typescript'])
        await symlink(
          path.dirname(require.resolve(`${name}/package.json`)),
          f.path('node_modules', name),
          'junction',
        );
      writeDeclaration('裿');
      const parsed = ts.getParsedCommandLineOfConfigFile(
        config,
        {},
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: vi.fn() },
      );
      expect(parsed).toBeDefined();
      const input = {
        checker: 'vue-tsc',
        sourceConfig: config,
        generatedConfig: config,
        parsed: parsed!,
        files: new Map<string, string>(),
        coverage: readFixtureSourceCoverage([config]),
        configs: [config],
        roots: [declaration],
        declarations: [declaration],
        requiresDelegationProof: false,
      };
      expect(observeVueDeclarationCandidate(input).sources).toContainEqual({
        file: declaration,
        defaultLibrary: false,
      });
      const spawn = childProcess.spawnSync;
      const replaceAfterWorker = vi
        .spyOn(childProcess, 'spawnSync')
        .mockImplementation((...arguments_) => {
          const result = spawn(...arguments_);
          writeDeclaration('觿');
          return result;
        });
      syncBuiltinESMExports();
      try {
        expect(() => observeVueDeclarationCandidate(input)).toThrow(
          DeclarationObservationUnavailable,
        );
        expect(replaceAfterWorker).toHaveBeenCalledTimes(1);
      } finally {
        replaceAfterWorker.mockRestore();
        syncBuiltinESMExports();
      }
    } finally {
      await f.cleanup();
    }
  },
);
