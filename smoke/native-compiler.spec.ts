import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertDistributionArtifacts,
  type ConsumerFixture,
  createConsumerFixture,
  packLiminaDistribution,
  runPnpm,
} from './helpers';

describe('packed Native compiler compatibility', () => {
  it.each(['5.4.2', '5.5.2', '5.6.2', '5.7.2', '5.8.2', '5.9.2', '6.0.2'])(
    'collects across processes and builds with TypeScript %s',
    async (version) => {
      const packed = await packLiminaDistribution();
      let fixture: ConsumerFixture | undefined;
      try {
        fixture = await createConsumerFixture({
          manifest: assertDistributionArtifacts(),
          tarballPath: packed.tarballPath,
          typeScriptVersion: version,
        });
        const requireFromFixture = createRequire(
          path.join(fixture.fixtureDir, 'package.json'),
        );
        const requireFromLimina = createRequire(
          requireFromFixture.resolve('limina/package.json'),
        );
        expect(requireFromLimina('typescript').version).toBe(version);
        await writeReferenceFixture(fixture.fixtureDir);
        const invocation = [
          'exec',
          'limina',
          '--config',
          './limina.config.mjs',
        ];
        for (const command of [
          ['graph', 'check'],
          ['graph', 'check'],
          ['checker', 'build'],
        ]) {
          const result = await runPnpm([...invocation, ...command], {
            cwd: fixture.fixtureDir,
          });
          expect(result.exitCode).toBe(0);
        }
        await writeFile(
          path.join(fixture.fixtureDir, 'app/src/peer.ts'),
          'export const value: string = 1;\n',
        );
        const invalid = await runPnpm([...invocation, 'checker', 'build'], {
          cwd: fixture.fixtureDir,
          reject: false,
        });
        expect(invalid.exitCode).not.toBe(0);
        expect(invalid.stdout + invalid.stderr).toContain('TS2322');
      } finally {
        await fixture?.cleanup();
        await packed.cleanup();
      }
    },
  );
});

async function writeReferenceFixture(root: string): Promise<void> {
  const options = {
    module: 'ESNext',
    moduleResolution: 'bundler',
    target: 'ES2022',
    strict: true,
    types: [],
  };
  await writeFile(
    path.join(root, 'app/src/index.ts'),
    '/// <reference lib="es2022" />\nexport {value} from "./peer.js";\n',
  );
  await writeFile(
    path.join(root, 'app/src/peer.ts'),
    'export const value = 1;\n',
  );
  await writeFile(
    path.join(root, 'app/tsconfig.lib.json'),
    JSON.stringify({
      compilerOptions: options,
      files: ['src/index.ts'],
    }),
  );
  await writeFile(
    path.join(root, 'app/tsconfig.json'),
    JSON.stringify({
      files: [],
      references: [
        { path: './tsconfig.lib.json' },
        { path: './tsconfig.peer.json' },
      ],
    }),
  );
  await writeFile(
    path.join(root, 'app/tsconfig.peer.json'),
    JSON.stringify({
      compilerOptions: { ...options, composite: true, outDir: '.tsbuild/peer' },
      files: ['src/peer.ts'],
    }),
  );
}
