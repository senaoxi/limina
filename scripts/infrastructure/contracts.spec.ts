import { collectBundledDependencies } from '@limina/build-tools/license-policy';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertNewReleaseTag } from '../release/check-tag';
import { createPackageSbom, readBundledInventory } from './artifacts';
import { analyzeAuditOutput } from './audit';

function audit(
  advisories: Record<string, unknown>,
  counts?: Record<string, number>,
): string {
  const effectiveCounts = counts ?? {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
  return JSON.stringify({
    advisories,
    metadata: { vulnerabilities: effectiveCounts },
  });
}

function advisory(severity: string): Record<string, string> {
  return {
    module_name: 'fixture-package',
    severity,
    title: 'Synthetic advisory',
    url: 'https://example.test/advisory',
  };
}

describe('dependency audit gate', () => {
  it('gates on returned findings even when exclusion metadata disagrees', () => {
    const high = analyzeAuditOutput(audit({ high: advisory('high') }), 0);
    assert.equal(high.failed, true);
    assert.equal(
      analyzeAuditOutput(
        audit({}, { info: 0, low: 0, moderate: 0, high: 4, critical: 1 }),
        0,
      ).failed,
      false,
    );
    const moderate = analyzeAuditOutput(
      audit({ moderate: advisory('moderate') }),
      1,
    );
    assert.equal(moderate.failed, false);
    assert.equal(moderate.counts.moderate, 1);
    const critical = analyzeAuditOutput(
      audit({ critical: advisory('critical') }),
      1,
    );
    assert.equal(critical.counts.critical, 1);
  });
  it('rejects transport failures, unsupported reports and unusable advisory evidence', () => {
    for (const [input, status] of [
      ['not JSON', 1],
      [JSON.stringify({ error: 'registry unavailable' }), 1],
      [JSON.stringify({ vulnerabilities: {} }), 0],
      [audit({}), 1],
      [audit({}), 2],
      [audit({ broken: advisory('unexpected') }), 1],
      [audit({ broken: { severity: 'high' } }), 1],
      [
        JSON.stringify({
          advisories: {},
          metadata: { vulnerabilities: { high: 0 } },
        }),
        0,
      ],
    ] as const)
      assert.throws(() => analyzeAuditOutput(input, status));
  });
});

describe('published artifact evidence', () => {
  it('rejects missing, conflicting and prohibited bundled license evidence', () => {
    assert.throws(
      () => collectBundledDependencies([{ name: 'fixture', version: '1.0.0' }]),
      /require/,
    );
    assert.throws(
      () =>
        collectBundledDependencies([
          { name: 'fixture', version: '1.0.0', license: 'GPL-3.0' },
        ]),
      /Prohibited/,
    );
    assert.throws(
      () =>
        collectBundledDependencies([
          { name: 'fixture', version: '1.0.0', license: 'MIT' },
          { name: 'fixture', version: '1.0.0', license: 'ISC' },
        ]),
      /Conflicting/,
    );
    assert.throws(
      () =>
        readBundledInventory(
          { packageName: 'other', dependencies: [] },
          'limina',
        ),
      /different package/,
    );
    assert.throws(
      () =>
        readBundledInventory(
          { packageName: 'limina', dependencies: [null] },
          'limina',
        ),
      /invalid/,
    );
  });
  it('records bundled development code without inventing external resolved versions', () => {
    const inventory = readBundledInventory(
      {
        packageName: 'limina',
        dependencies: [
          { name: '@fixture/bundled', version: '1.2.3', license: 'MIT' },
        ],
      },
      'limina',
    );
    const sbom = createPackageSbom(
      {
        name: 'limina',
        version: '2.0.0',
        dependencies: { external: '^3.0.0' },
      },
      inventory,
      'sha512-fixture',
    );
    assert.equal(sbom.components[0]!.purl, 'pkg:npm/%40fixture/bundled@1.2.3');
    assert.equal(sbom.components[0]!.licenses[0]!.license.id, 'MIT');
    assert.equal(
      sbom.components.some((component) => component.name === 'external'),
      false,
    );
    assert.deepEqual(sbom.properties, [
      { name: 'limina:external-requirement:external', value: '^3.0.0' },
    ]);
    assert.deepEqual(sbom.dependencies[0]!.dependsOn, [
      'pkg:npm/%40fixture/bundled@1.2.3',
    ]);
  });
});

it('rejects imported tags and malformed selectors before release or deployment', () => {
  assert.equal(
    assertNewReleaseTag('limina/v1.2.3-beta.1', ['limina/v0.4.0']),
    '1.2.3-beta.1',
  );
  assert.throws(
    () => assertNewReleaseTag('limina/v0.4.0', ['limina/v0.4.0']),
    /historical/,
  );
  for (const tag of [
    'main',
    'other/v1.2.3',
    'limina/v1.2.3/../main',
    'limina/v1.2.3\n',
  ]) {
    assert.throws(() => assertNewReleaseTag(tag, []), /Expected/);
  }
});
