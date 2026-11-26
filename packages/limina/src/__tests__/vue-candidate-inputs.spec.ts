import childProcess from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { DeclarationObservationUnavailable } from '../core/declaration-governance/candidate';
import { observeVueDeclarationCandidate } from '../core/vue-semantic/declaration-candidate';
import { readFixtureSourceCoverage } from './helpers/native-coverage';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

const require = createRequire(import.meta.url);

async function linkCandidateToolchain(
  f: Awaited<ReturnType<typeof createSemanticRepairFixture>>,
) {
  await mkdir(f.path('node_modules'), { recursive: true });
  for (const name of ['vue-tsc', 'typescript'])
    await symlink(
      path.dirname(require.resolve(`${name}/package.json`)),
      f.path('node_modules', name),
      'junction',
    );
}

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
      await linkCandidateToolchain(f);
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

it('observes a staged Vue library forwarding manifest and rejects a late replacement', async () => {
  const f = await createSemanticRepairFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM'],
        libReplacement: true,
        types: [],
      },
      files: ['entry.d.ts'],
    }),
    'entry.d.ts': '/// <reference lib="dom" />\nexport {};',
    'dom.d.ts': 'declare const selectedLibrary: "staged";',
  });
  try {
    await linkCandidateToolchain(f);
    const sourceConfig = f.path('tsconfig.json');
    const generatedConfig = f.path('generated/tsconfig.json');
    const declaration = f.path('entry.d.ts');
    const input = {
      checker: 'vue-tsc',
      sourceConfig,
      generatedConfig,
      parsed: f.parse(),
      files: new Map([
        [generatedConfig, JSON.stringify({ extends: '../tsconfig.json' })],
        [
          f.path('generated/node_modules/@typescript/lib-dom/package.json'),
          JSON.stringify({ types: '../../../../dom.d.ts' }),
        ],
      ]),
      coverage: readFixtureSourceCoverage([sourceConfig]),
      configs: [generatedConfig],
      roots: [declaration],
      declarations: [declaration],
      requiresDelegationProof: false,
    };
    const observed = observeVueDeclarationCandidate(input);
    expect(observed.requests).toContainEqual(
      expect.objectContaining({
        file: declaration,
        channel: 'library',
        specifier: 'dom',
        resolutionState: 'resolved',
        target: f.path('dom.d.ts'),
      }),
    );

    const replacement = f.path('generated/node_modules/@typescript/lib-es2022');
    const spawn = childProcess.spawnSync;
    const introduceReplacement = vi
      .spyOn(childProcess, 'spawnSync')
      .mockImplementation((...arguments_) => {
        const result = spawn(...arguments_);
        expect(result.status).toBe(0);
        mkdirSync(replacement, { recursive: true });
        writeFileSync(
          f.path('generated/node_modules/@typescript/lib-es2022/package.json'),
          JSON.stringify({ types: 'index.d.ts' }),
        );
        writeFileSync(
          f.path('generated/node_modules/@typescript/lib-es2022/index.d.ts'),
          'declare const lateLibrary: "materialized";',
        );
        return result;
      });
    syncBuiltinESMExports();
    try {
      expect(() => observeVueDeclarationCandidate(input)).toThrow(
        `Vue candidate lookup changed: ${replacement}`,
      );
    } finally {
      introduceReplacement.mockRestore();
      syncBuiltinESMExports();
    }
  } finally {
    await f.cleanup();
  }
});
