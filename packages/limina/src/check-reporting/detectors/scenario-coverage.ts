import type { DetectorScenarioCoverageRegistry } from './types';

export const LIMINA_DETECTOR_SCENARIO_COVERAGE: DetectorScenarioCoverageRegistry =
  {
    'checker/build-valid': {
      fixturePath:
        'packages/limina/fixtures/detectors/checker/build-valid/case.mts',
      kind: 'passing-control',
      reason: 'Confirms a real TypeScript checker build produces no issue.',
    },
    'fault-injection/cleanup-descriptor-execution': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/cleanup-descriptor-execution/case.mts',
      kind: 'fault-boundary',
      reason: 'Constrains cleanup descriptor accounting after finalization.',
    },
    'fault-injection/cleanup-success': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/cleanup-success/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains a cleanup failure that does not emit a canonical issue.',
    },
    'fault-injection/filesystem-close-eio': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/filesystem-close-eio/case.mts',
      kind: 'fault-boundary',
      reason: 'Constrains close failure propagation and cleanup state.',
    },
    'fault-injection/filesystem-fsync-eio': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/filesystem-fsync-eio/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains fsync failure propagation without fabricated issue output.',
    },
    'fault-injection/filesystem-rename-eio': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/filesystem-rename-eio/case.mts',
      kind: 'fault-boundary',
      reason: 'Constrains atomic rename failure and temporary-file cleanup.',
    },
    'fault-injection/filesystem-write-eio': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/filesystem-write-eio/case.mts',
      kind: 'fault-boundary',
      reason: 'Constrains snapshot write failure and temporary-file cleanup.',
    },
    'fault-injection/finalization-secondary-after-task-failure': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/finalization-secondary-after-task-failure/case.mts',
      kind: 'fault-boundary',
      reason: 'Preserves a primary task failure when finalization also fails.',
    },
    'fault-injection/finalization-success': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/finalization-success/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains finalization failure after otherwise successful work.',
    },
    'fault-injection/process-invalid-protocol': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/process-invalid-protocol/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains invalid child protocol handling without issue synthesis.',
    },
    'fault-injection/snapshot-install-success': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/snapshot-install-success/case.mts',
      kind: 'fault-boundary',
      reason: 'Constrains snapshot installation failure and cleanup state.',
    },
    'fault-injection/snapshot-serialize-success': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/snapshot-serialize-success/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains snapshot serialization failure without issue synthesis.',
    },
    'fault-injection/snapshot-write-success': {
      fixturePath:
        'packages/limina/fixtures/detectors/fault-injection/snapshot-write-success/case.mts',
      kind: 'fault-boundary',
      reason:
        'Constrains snapshot write failure after successful task execution.',
    },
    'package/attw-dual-package-valid': {
      fixturePath:
        'packages/limina/fixtures/detectors/package/attw-dual-package-valid/case.mts',
      kind: 'passing-control',
      reason: 'Confirms ATTW emits no issue for a valid dual package.',
    },
    'proof/coverage-valid': {
      fixturePath:
        'packages/limina/fixtures/detectors/proof/coverage-valid/case.mts',
      kind: 'passing-control',
      reason: 'Confirms valid proof coverage emits no issue.',
    },
    'release/content-hash-builtin-ignore': {
      fixturePath:
        'packages/limina/fixtures/detectors/release/content-hash-builtin-ignore/case.mts',
      kind: 'passing-control',
      reason: 'Confirms built-in ignored content differences emit no issue.',
    },
    'release/content-hash-user-ignore': {
      fixturePath:
        'packages/limina/fixtures/detectors/release/content-hash-user-ignore/case.mts',
      kind: 'passing-control',
      reason: 'Confirms configured ignored content differences emit no issue.',
    },
    'release/tarball-valid': {
      fixturePath:
        'packages/limina/fixtures/detectors/release/tarball-valid/case.mts',
      kind: 'passing-control',
      reason: 'Confirms a valid release tarball emits no issue.',
    },
    'source/knip-usage-valid': {
      fixturePath:
        'packages/limina/fixtures/detectors/source/knip-usage-valid/case.mts',
      kind: 'passing-control',
      reason:
        'Confirms used modules and workspace dependencies emit no Knip issue.',
    },
  };
