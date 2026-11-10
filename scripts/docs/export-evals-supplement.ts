import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

interface FormalResults {
  sourceSummarySha256: string;
  productIdentity: string;
  skillDigest: string;
  batches: {
    development: {
      domains: { tasks: { id: string; base: Score; skill: Score }[] }[];
    };
  };
}
interface Score {
  passed: number;
  attempts: number;
}
interface DiagnosticRow {
  batch: string;
  condition: string;
  repetition: number;
  outcome: { status: string; isValidAttempt: boolean; safety: string };
  diagnosis: {
    status: string;
    target: string;
    nearestManifest: string;
    reason: string;
  };
  assertions: { id: string; passed: boolean }[];
  trace: { status: string };
}
export interface I03Diagnostic {
  version: number;
  observedAt: string;
  formalComparison: boolean;
  realAgentAttempts: number;
  frozenIdentity: {
    kind: string;
    productIdentity: string;
    skillDigest: string;
    task: { id: string; gradingDigest: string };
  };
  integrity: {
    originalResultFilesUnchanged: boolean;
    allEvidenceHashesValid: boolean;
    nativeTraceAndUsageReconciled: boolean;
    exactStartSnapshotsMatchPerCondition: boolean;
    promptsUnchanged: boolean;
  };
  rows: DiagnosticRow[];
}
const conditions = ['base', 'skill'] as const;
const assertionIds = [
  'nearest-manifest-diagnosed',
  'init-rejects-invalid-manifest',
  'ancestor-not-initialized',
];
const formalFile = fileURLToPath(
  new URL('../../docs/.vitepress/theme/evals-results.json', import.meta.url),
);

// A projection of one audited diagnostic, never a replacement formal report.
export function publicI03Supplement(
  source: I03Diagnostic,
  sourceDigest: string,
  formal: FormalResults,
) {
  assert.match(sourceDigest, /^[a-f\d]{64}$/u);
  assert.equal(source.formalComparison, false, 'Diagnostic must stay separate');
  assert.ok(
    source.version === 1 &&
      source.realAgentAttempts === 6 &&
      source.frozenIdentity.kind === 'supplemental-diagnostic' &&
      source.frozenIdentity.task.id === 'I03',
    'Expected a separate six-attempt I03 diagnostic',
  );
  assert.ok(
    source.frozenIdentity.productIdentity === formal.productIdentity &&
      source.frozenIdentity.skillDigest === formal.skillDigest,
    'Frozen product or Skill differs',
  );
  for (const key of [
    'originalResultFilesUnchanged',
    'allEvidenceHashesValid',
    'nativeTraceAndUsageReconciled',
    'exactStartSnapshotsMatchPerCondition',
    'promptsUnchanged',
  ] as const)
    assert.equal(source.integrity[key], true, 'Incomplete diagnostic evidence');
  assert.match(source.observedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.ok(Number.isFinite(Date.parse(source.observedAt)), 'Invalid date');
  assert.match(source.frozenIdentity.task.gradingDigest, /^[a-f\d]{64}$/u);
  const original = formal.batches.development.domains
    .flatMap((domain) => domain.tasks)
    .find((task) => task.id === 'I03');
  assert.ok(original, 'Original I03 results missing');
  assert.equal(
    source.rows.length,
    12,
    'Expected historical and supplemental rows',
  );
  const groups = (['historical', 'supplemental'] as const).map((batch) =>
    Object.fromEntries(
      conditions.map((condition) => {
        const rows = source.rows
          .filter((row) => row.batch === batch && row.condition === condition)
          .toSorted((a, b) => a.repetition - b.repetition);
        assert.deepEqual(
          rows.map((row) => row.repetition),
          [1, 2, 3],
          'Missing or duplicate independent repetitions',
        );
        for (const row of rows) {
          const isPassed = row.outcome.status === 'passed';
          assert.ok(
            row.outcome.isValidAttempt &&
              row.outcome.safety === 'safe' &&
              row.trace.status === 'complete' &&
              ['passed', 'assertion_failed'].includes(row.outcome.status),
            'Unknown or unsafe attempt',
          );
          assert.ok(
            row.diagnosis.status === 'blocked' &&
              row.diagnosis.nearestManifest === 'nested/package.json' &&
              row.diagnosis.reason === 'invalid_manifest' &&
              row.diagnosis.target === (isPassed ? 'nested/app' : 'nested'),
            'Unclassified diagnostic outcome',
          );
          assert.deepEqual(
            row.assertions,
            assertionIds.map((id, index) => ({
              id,
              passed: index > 0 || isPassed,
            })),
            'Outcome disagrees with required assertions',
          );
        }
        const score = {
          passed: rows.filter((row) => row.outcome.status === 'passed').length,
          attempts: rows.length,
        };
        if (batch === 'historical') {
          assert.equal(
            score.passed,
            original[condition].passed,
            'Original score differs',
          );
          assert.equal(
            score.attempts,
            original[condition].attempts,
            'Original count differs',
          );
        }
        return [
          condition,
          {
            ...score,
            repetitions: rows.map((row) => ({
              repetition: row.repetition,
              passed: row.outcome.status === 'passed',
              target: row.diagnosis.target,
            })),
          },
        ];
      }),
    ),
  );
  return {
    schemaVersion: 1,
    kind: 'supplemental-diagnostic',
    taskId: 'I03',
    measuredOn: source.observedAt.slice(0, 10),
    includedInFormalScores: false,
    sourceAnalysisSha256: sourceDigest,
    originalSummarySha256: formal.sourceSummarySha256,
    productIdentity: formal.productIdentity,
    skillDigest: formal.skillDigest,
    gradingIdentity: source.frozenIdentity.task.gradingDigest,
    original: groups[0]!,
    supplemental: groups[1]!,
  };
}

async function main() {
  const [sourceFile, expectedHash, destination] = process.argv.slice(2);
  assert.ok(
    sourceFile && expectedHash,
    'Usage: export-evals-supplement.ts <analysis.json> <expected-sha256> [output-json]',
  );
  const bytes = await readFile(sourceFile);
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash, expectedHash, 'Diagnostic integrity differs');
  const formal = JSON.parse(
    await readFile(formalFile, 'utf8'),
  ) as FormalResults;
  const result = publicI03Supplement(
    JSON.parse(bytes.toString()) as I03Diagnostic,
    hash,
    formal,
  );
  const output = destination
    ? path.resolve(destination)
    : fileURLToPath(
        new URL(
          '../../docs/.vitepress/theme/evals-i03-supplement.json',
          import.meta.url,
        ),
      );
  assert.ok(
    output !== path.resolve(sourceFile) && output !== formalFile,
    'Cannot overwrite source or formal results',
  );
  await writeFile(
    output,
    await format(JSON.stringify(result), { parser: 'json' }),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
