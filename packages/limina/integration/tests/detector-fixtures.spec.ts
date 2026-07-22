/// <reference types="vite/client" />

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { LiminaCheckIssueCode } from '../../src/check-reporting/codes';
import {
  LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE,
  LIMINA_DETECTOR_SCENARIO_COVERAGE,
} from '../../src/check-reporting/detector-coverage';
import { discoverDetectorFixtures } from '../helpers/detector-fixture-discovery';
import { runDetectorFixture } from '../helpers/detector-fixture-runner';

const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const detectorRoot = fileURLToPath(
  new URL('../../fixtures/detectors/', import.meta.url),
);
const caseModules = new Map(
  Object.entries(
    import.meta.glob('../../fixtures/detectors/**/case.mts', {
      eager: true,
    }),
  ).map(([specifier, caseModule]) => [
    fileURLToPath(new URL(specifier, import.meta.url)),
    caseModule,
  ]),
);
const detectorFixtures = await discoverDetectorFixtures({
  caseModules,
  detectorRoot,
});

function toWorkspaceRelativePath(filePath: string): string {
  return path.relative(workspaceRoot, filePath).split(path.sep).join('/');
}

describe('declarative detector fixtures', () => {
  it('discovers the checked-in fixtures in portable order', () => {
    expect(detectorFixtures.map((fixture) => fixture.id)).toEqual([
      'checker/build-valid',
      'checker/peer-dependency-missing',
      'checker/target-selection-preset',
      'fault-injection/checker-build-throw',
      'fault-injection/checker-typecheck-throw',
      'fault-injection/cleanup-descriptor-execution',
      'fault-injection/cleanup-descriptor-failure',
      'fault-injection/cleanup-secondary-after-task-failure',
      'fault-injection/cleanup-success',
      'fault-injection/command-throw',
      'fault-injection/filesystem-close-eio',
      'fault-injection/filesystem-fsync-eio',
      'fault-injection/filesystem-read-eio',
      'fault-injection/filesystem-rename-eio',
      'fault-injection/filesystem-write-eio',
      'fault-injection/finalization-secondary-after-task-failure',
      'fault-injection/finalization-success',
      'fault-injection/graph-check-throw',
      'fault-injection/graph-materialize-throw',
      'fault-injection/graph-prepare-throw',
      'fault-injection/package-check-throw',
      'fault-injection/process-invalid-protocol',
      'fault-injection/process-nonzero-exit',
      'fault-injection/process-signal-termination',
      'fault-injection/process-spawn-enoent',
      'fault-injection/process-stderr-error',
      'fault-injection/process-stdout-error',
      'fault-injection/process-timeout',
      'fault-injection/proof-check-throw',
      'fault-injection/release-check-throw',
      'fault-injection/snapshot-install-success',
      'fault-injection/snapshot-secondary-after-task-failure',
      'fault-injection/snapshot-serialize-success',
      'fault-injection/snapshot-write-success',
      'fault-injection/source-check-throw',
      'fault-injection/timeout-cleanup-secondary',
      'fault-injection/workspace-validation-throw',
      'graph/access-denied-import-dependency',
      'graph/access-denied-reference',
      'graph/condition-domain-mismatch',
      'graph/condition-domain-reference-mismatch',
      'graph/config-invalid-condition-domain',
      'graph/config-invalid-condition-domain-entry',
      'graph/config-invalid-rule',
      'graph/config-invalid-workspace-export',
      'graph/import-target-unmapped',
      'graph/reference-cycle-mutual',
      'graph/workspace-import-missing-type-entry',
      'graph/workspace-import-outside-graph',
      'graph/workspace-import-unresolved',
      'package/attw-cjs-only-exports-default',
      'package/attw-cjs-resolves-to-esm',
      'package/attw-dual-package-valid',
      'package/attw-fallback-condition',
      'package/attw-false-cjs',
      'package/attw-false-esm',
      'package/attw-false-export-default',
      'package/attw-internal-resolution-error',
      'package/attw-missing-export-equals',
      'package/attw-named-exports',
      'package/attw-no-resolution-bundler',
      'package/attw-unexpected-module-syntax',
      'package/attw-untyped-resolution-bundler',
      'package/boundary-browser-node-builtin',
      'package/boundary-external-package-undeclared',
      'package/boundary-imports-invalid-target',
      'package/boundary-imports-missing',
      'package/boundary-imports-null-target',
      'package/boundary-imports-target-escapes-root',
      'package/boundary-imports-target-missing',
      'package/boundary-imports-target-unsupported',
      'package/boundary-self-import-not-exported',
      'package/manifest-local-specifier-catalog',
      'package/manifest-local-specifier-file',
      'package/manifest-local-specifier-link',
      'package/manifest-local-specifier-workspace',
      'package/manifest-name-missing',
      'package/publint-export-file-missing',
      'package/publint-exports-types-order',
      'package/publint-module-should-be-esm',
      'proof/allowlist-file-empty',
      'proof/checker-source-references',
      'proof/coverage-missing',
      'proof/coverage-valid',
      'proof/default-tsconfig-missing',
      'proof/duplicate-graph-json',
      'proof/duplicate-source-owner',
      'proof/source-boundary-mismatch',
      'release/content-hash-builtin-ignore',
      'release/content-hash-changed',
      'release/content-hash-config-invalid-baseline-tag',
      'release/content-hash-config-invalid-ignore',
      'release/content-hash-local-only',
      'release/content-hash-remote-only',
      'release/content-hash-user-ignore',
      'release/content-hash-user-ignore-non-match',
      'release/packed-dependency-missing',
      'release/packed-dependency-range-mismatch',
      'release/packed-manifest-lint',
      'release/packed-output-catalog-specifier',
      'release/packed-output-file-specifier',
      'release/packed-output-link-specifier',
      'release/packed-output-workspace-specifier',
      'release/packed-source-link-dependency',
      'release/packed-source-private-dependency',
      'release/packed-source-workspace-dependency-missing',
      'release/registry-comparison-failed',
      'release/registry-dist-tag-missing',
      'release/registry-integrity-invalid',
      'release/registry-integrity-mismatch',
      'release/registry-integrity-missing',
      'release/registry-integrity-priority',
      'release/registry-metadata-body-read',
      'release/registry-metadata-http-status',
      'release/registry-metadata-invalid-json',
      'release/registry-metadata-invalid-object',
      'release/registry-metadata-request',
      'release/registry-metadata-timeout',
      'release/registry-package-not-found',
      'release/registry-shasum-invalid',
      'release/registry-shasum-mismatch',
      'release/registry-tarball-body-read',
      'release/registry-tarball-http-status',
      'release/registry-tarball-request',
      'release/registry-tarball-timeout',
      'release/registry-tarball-url-missing',
      'release/registry-version-missing',
      'release/tarball-license-missing',
      'release/tarball-output-private',
      'release/tarball-readme-missing',
      'release/tarball-source-map',
      'release/tarball-source-mapping-url',
      'release/tarball-valid',
      'source/ambient-config-no-matches',
      'source/ambient-reference-unauthorized',
      'source/ambient-shared-unauthorized',
      'source/cross-governance-require-resolve',
      'source/import-authority-unknown-owner',
      'source/knip-build-script-unsupported',
      'source/knip-config-workspaces-invalid',
      'source/knip-usage-valid',
      'source/owner-conflict',
      'source/package-import-invalid',
      'source/package-import-unauthorized',
      'source/relative-import-escapes-scope',
      'source/tsconfig-module-owner-unresolved',
      'source/unused-module',
      'source/unused-workspace-dependency',
      'workspace/output-cycle-mutual',
      'workspace/output-cycle-self',
      'workspace/output-root-canonical-alias',
      'workspace/output-root-repository',
      'workspace/package-identity-conflict',
      'workspace/region-overlap',
    ]);
  });

  it('keeps canonical coverage and scenario ownership bidirectionally exact', () => {
    const fixtureByPath = new Map(
      detectorFixtures.map((fixture) => [
        toWorkspaceRelativePath(fixture.casePath),
        fixture,
      ]),
    );
    const canonicalOwnersByPath = new Map<string, Set<LiminaCheckIssueCode>>();

    for (const [code, coverage] of Object.entries(
      LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE,
    ) as [
      LiminaCheckIssueCode,
      (typeof LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE)[LiminaCheckIssueCode],
    ][]) {
      if (!('tests' in coverage)) {
        continue;
      }

      for (const testPath of coverage.tests.filter((candidate) =>
        candidate.startsWith('packages/limina/fixtures/detectors/'),
      )) {
        const fixture = fixtureByPath.get(testPath);

        expect(fixture, `${code} references ${testPath}`).toBeDefined();
        expect(
          fixture?.definition.expected.issues.some(
            (issue) => issue.code === code,
          ),
          `${code} is not asserted by ${testPath}`,
        ).toBe(true);

        const owners = canonicalOwnersByPath.get(testPath) ?? new Set();
        owners.add(code);
        canonicalOwnersByPath.set(testPath, owners);

        if (coverage.kind === 'fault-injection') {
          expect(fixture?.definition.kind).toBe('fault-injection');
        }
      }
    }

    const scenarioIds = detectorFixtures
      .filter(
        (fixture) => fixture.definition.expected.primaryCode === undefined,
      )
      .map((fixture) => fixture.id)
      .sort();

    expect(Object.keys(LIMINA_DETECTOR_SCENARIO_COVERAGE).sort()).toEqual(
      scenarioIds,
    );

    for (const fixture of detectorFixtures) {
      const casePath = toWorkspaceRelativePath(fixture.casePath);
      const expectedCodes = new Set(
        fixture.definition.expected.issues.map((issue) => issue.code),
      );
      const canonicalOwners = canonicalOwnersByPath.get(casePath) ?? new Set();
      const primaryCode = fixture.definition.expected.primaryCode;
      const scenario = LIMINA_DETECTOR_SCENARIO_COVERAGE[fixture.id];

      if (primaryCode) {
        expect(canonicalOwners.has(primaryCode), fixture.id).toBe(true);
        expect([...canonicalOwners].sort(), fixture.id).toEqual(
          [...expectedCodes].sort(),
        );
        expect(scenario, fixture.id).toBeUndefined();
        continue;
      }

      expect(fixture.definition.expected.issues, fixture.id).toEqual([]);
      expect([...canonicalOwners], fixture.id).toEqual([]);
      expect(scenario, fixture.id).toEqual({
        fixturePath: casePath,
        kind:
          fixture.definition.kind === 'fault-injection'
            ? 'fault-boundary'
            : 'passing-control',
        reason: expect.stringMatching(/\S/u),
      });
    }
  });

  for (const fixture of detectorFixtures) {
    it(fixture.id, async () => {
      const result = await runDetectorFixture(fixture);

      expect(result.fixtureId).toBe(fixture.id);
      expect(result.preserved || result.cleaned).toBe(true);
    });
  }
});
