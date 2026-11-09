import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  publicI03Supplement,
  type I03Diagnostic,
} from './export-evals-supplement';

function fixture() {
  const formal = {
    sourceSummarySha256: 'a'.repeat(64),
    productIdentity: 'b'.repeat(64),
    skillDigest: 'c'.repeat(64),
    batches: {
      development: {
        domains: [
          {
            tasks: [
              {
                id: 'I03',
                base: { passed: 3, attempts: 3 },
                skill: { passed: 1, attempts: 3 },
              },
            ],
          },
        ],
      },
    },
  };
  const source: I03Diagnostic = {
    version: 1,
    observedAt: '2026-11-06T00:00:00.000Z',
    formalComparison: false,
    realAgentAttempts: 6,
    frozenIdentity: {
      kind: 'supplemental-diagnostic',
      productIdentity: formal.productIdentity,
      skillDigest: formal.skillDigest,
      task: { id: 'I03', gradingDigest: 'd'.repeat(64) },
    },
    integrity: {
      originalResultFilesUnchanged: true,
      allEvidenceHashesValid: true,
      nativeTraceAndUsageReconciled: true,
      exactStartSnapshotsMatchPerCondition: true,
      promptsUnchanged: true,
    },
    rows: ['historical', 'supplemental'].flatMap((batch) =>
      ['base', 'skill'].flatMap((condition) =>
        [1, 2, 3].map((repetition) => {
          const isPassed =
            batch !== 'historical' || condition !== 'skill' || repetition === 3;
          return {
            batch,
            condition,
            repetition,
            outcome: {
              status: isPassed ? 'passed' : 'assertion_failed',
              isValidAttempt: true,
              safety: 'safe',
            },
            diagnosis: {
              status: 'blocked',
              target: isPassed ? 'nested/app' : 'nested',
              nearestManifest: 'nested/package.json',
              reason: 'invalid_manifest',
            },
            trace: { status: 'complete' },
            assertions: [
              'nearest-manifest-diagnosed',
              'init-rejects-invalid-manifest',
              'ancestor-not-initialized',
            ].map((id, index) => ({ id, passed: index > 0 || isPassed })),
          };
        }),
      ),
    ),
  };
  return { source, formal };
}

it('exports I03 repetitions separately, retaining failures and excluding private evidence', () => {
  const { source, formal } = fixture();
  const before = structuredClone(formal);
  Object.assign(source, {
    controller: '/private/control',
    secret: 'fictional-secret',
    rawTrace: 'private trace',
  });
  Object.assign(source.rows[0]!, {
    visibleFinalMessage: 'private message',
    runId: 'private-run',
  });
  const result = publicI03Supplement(source, 'e'.repeat(64), formal);
  assert.equal(result.includedInFormalScores, false);
  assert.equal(result.original.skill!.passed, 1);
  assert.equal(result.supplemental.skill!.passed, 3);
  assert.deepEqual(
    result.original.skill!.repetitions.map((r) => r.passed),
    [false, false, true],
  );
  assert.deepEqual(
    result.supplemental.skill!.repetitions.map((r) => r.target),
    ['nested/app', 'nested/app', 'nested/app'],
  );
  assert.deepEqual(formal, before);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private|fictional-secret|macroPassRate|lift|regression/u,
  );
});

it('rejects changed inputs, omitted repeats, unknown evidence and rewritten original scores', () => {
  const mutations: ((source: I03Diagnostic) => void)[] = [
    (s) => {
      s.frozenIdentity.skillDigest = 'f'.repeat(64);
    },
    (s) => {
      s.rows.pop();
    },
    (s) => {
      s.rows[11]!.repetition = 2;
    },
    (s) => {
      s.rows[11]!.trace.status = 'unknown';
    },
    (s) => {
      s.integrity.exactStartSnapshotsMatchPerCondition = false;
    },
    (s) => {
      s.rows[3]!.outcome.status = 'passed';
    },
    (s) => {
      s.rows[11]!.assertions[0]!.passed = false;
    },
  ];
  for (const mutate of mutations) {
    const { source, formal } = fixture();
    mutate(source);
    assert.throws(() => publicI03Supplement(source, 'e'.repeat(64), formal));
  }
});

it('rejects an untrusted diagnostic hash before writing an export', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'evals-supplement-export-'),
  );
  const source = path.join(directory, 'analysis.json');
  const output = path.join(directory, 'public.json');
  try {
    await writeFile(source, JSON.stringify(fixture().source));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('export-evals-supplement.ts', import.meta.url)),
        source,
        '0'.repeat(64),
        output,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Diagnostic integrity differs/u);
    assert.equal(existsSync(output), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
