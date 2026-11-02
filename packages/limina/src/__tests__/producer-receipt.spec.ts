import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { assertProducerBuildReceipt } from '../core/build-graph/producer-receipt';
import { LiminaPreflightManager } from '../preflight';
import { ensureBuilt } from '../typecheck/checker/build-runner';
import { createDefaultRunner } from '../typecheck/targets';
import { withFixtureGovernanceRoot } from './helpers/governance-root';
import { createSemanticRepairFixture } from './helpers/semantic-repair';

it('revokes a real producer receipt after external declaration or in-memory plan drift', async () => {
  const fixture = await createSemanticRepairFixture({
    'package.json': JSON.stringify({
      name: 'receipt-inputs',
      private: true,
      type: 'module',
      dependencies: { 'external-value': '1.0.0' },
    }),
    'src/index.ts':
      'import type { Value } from "external-value"; export const value: Value = 1;',
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        composite: true,
        declaration: true,
        strict: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
        lib: ['ES2022'],
      },
      include: ['src'],
    }),
    'node_modules/external-value/package.json': JSON.stringify({
      name: 'external-value',
      version: '1.0.0',
      types: 'index.d.ts',
    }),
    'node_modules/external-value/index.d.ts': 'export type Value = number;',
  });
  const config = withFixtureGovernanceRoot({
    rootDir: fixture.root,
    configPath: fixture.path('limina.config.mjs'),
    scope: { checkers: { tsc: { include: ['tsconfig.json'] } } },
  });
  const preflight = new LiminaPreflightManager({ config });
  try {
    const built = await ensureBuilt({
      config,
      preflight,
      cwd: fixture.root,
      runner: createDefaultRunner({ stdio: 'ignore' }),
    });
    expect(built.result.passed).toBe(true);
    const receipt = built.receipt!;
    expect(receipt).toBeDefined();
    expect(() => assertProducerBuildReceipt(receipt)).not.toThrow();
    await writeFile(
      fixture.path('node_modules/external-value/index.d.ts'),
      'export type Value = string;',
    );
    expect(() => assertProducerBuildReceipt(receipt)).toThrow(/input changed/u);
    await writeFile(
      fixture.path('node_modules/external-value/index.d.ts'),
      'export type Value = number;',
    );
    expect(() => assertProducerBuildReceipt(receipt)).not.toThrow();
    const generated = receipt.plan.sourceToDts
      .get('tsc')!
      .get(fixture.path('tsconfig.json'))!;
    const files = receipt.plan.generatedFiles as Map<string, string>;
    const original = files.get(generated)!;
    const changed = JSON.parse(original);
    changed.compilerOptions.strict = false;
    files.set(generated, JSON.stringify(changed));
    expect(() => assertProducerBuildReceipt(receipt)).toThrow(
      /compilation semantics/u,
    );
    files.set(generated, original);
    expect(() => assertProducerBuildReceipt(receipt)).not.toThrow();
  } finally {
    preflight.dispose();
    await fixture.cleanup();
  }
});
