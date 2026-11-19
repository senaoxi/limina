import { createHash } from 'node:crypto';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  assertProducerBuildReceipt,
  issueProducerBuildReceipt,
} from '../core/build-graph/producer-receipt';
import { createSvelteDeclarationBindings } from '../core/build-graph/svelte-consumer-view';
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
  const input = fixture.path('node_modules/external-value/index.d.ts');
  const prefix = Buffer.from('export type Value = number; // ');
  const bytes = (marker: number) =>
    Buffer.concat([prefix, Buffer.from([marker])]);
  const replace = async (file: string, value: Buffer) => {
    await writeFile(file, value);
    await utimes(file, 1000, 1000);
  };
  try {
    await replace(input, bytes(0x80));
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
    await replace(input, bytes(0x80));
    expect(() => assertProducerBuildReceipt(receipt)).not.toThrow();
    await replace(input, bytes(0x81));
    expect(() => assertProducerBuildReceipt(receipt)).toThrow(/input changed/u);
    await writeFile(input, 'export type Value = string;');
    expect(() => assertProducerBuildReceipt(receipt)).toThrow(/input changed/u);
    await replace(input, bytes(0x80));
    expect(() => assertProducerBuildReceipt(receipt)).not.toThrow();

    const { outputFile } = receipt.declarations[0]!;
    const originalOutput = await readFile(outputFile);
    const outputText = `${ts.sys.readFile(outputFile)}// 裿\n`;
    const toBigEndian = (text: string) =>
      Buffer.from(`\u{FEFF}${text}`, 'utf16le').swap16();
    const encoded = toBigEndian(outputText);
    await replace(outputFile, encoded);
    const reissued = issueProducerBuildReceipt(
      receipt.plan,
      receipt,
      fixture.root,
    );
    const bindings = createSvelteDeclarationBindings(reissued, fixture.root);
    const [mirror] = bindings.values();
    expect(mirror!.content).toBe(ts.sys.readFile(outputFile));
    expect(mirror!.contentIdentity).toBe(
      createHash('sha256').update(encoded).digest('hex'),
    );
    await replace(outputFile, encoded);
    expect(() => assertProducerBuildReceipt(reissued)).not.toThrow();
    await replace(outputFile, toBigEndian(outputText.replace('裿', '觿')));
    expect(() => assertProducerBuildReceipt(reissued)).toThrow(
      /Producer declaration changed after build/u,
    );
    await replace(outputFile, originalOutput);
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

    const units = receipt.plan.governedSources.get('tsc')!;
    const configPath = fixture.path('tsconfig.json');
    const unit = units.get(configPath)!;
    const { kind, family, source } = unit.semanticAuthority;
    const projected = new Map(units).set(configPath, {
      ...unit,
      semanticAuthority: { kind, family, source },
    });
    const finalGraph = {
      ...receipt.plan,
      governedSources: new Map(receipt.plan.governedSources).set(
        'tsc',
        projected,
      ),
    };
    expect(() => assertProducerBuildReceipt(receipt, finalGraph)).not.toThrow();
    projected.set(configPath, {
      ...unit,
      semanticAuthority: { kind, family, source: 'baseline' },
    });
    expect(() => assertProducerBuildReceipt(receipt, finalGraph)).toThrow(
      /frozen checker ownership or semantic authority/u,
    );
  } finally {
    preflight.dispose();
    await fixture.cleanup();
  }
});
