import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { contentIdentity } from './identity.ts';
import { assertDigest } from './model-profile.ts';
import type { EvidenceReference, RunStore } from './run-store.ts';
import { assertRelativePath, sha256 } from './snapshot.ts';

export const causes = [
  'skill_not_triggered',
  'skill_not_discovered',
  'skill_content_missing',
  'skill_content_conflict',
  'skill_not_followed',
  'agent_error',
  'product_limit',
  'checker_limit',
  'grader_defect',
  'task_contract',
  'infrastructure',
  'unknown',
] as const;
export interface FailureAttribution {
  runId: string;
  rubricDigest: string;
  primary: (typeof causes)[number];
  contributing: (typeof causes)[number][];
  evidence: EvidenceReference[];
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  adjudication: 'unreviewed' | 'proposed' | 'reviewed' | 'disputed';
}
interface Entry {
  previous: string | null;
  attribution: FailureAttribution;
  digest: string;
}
export function readAttributions(store: RunStore, snapshot?: string): Entry[] {
  const file = path.join(store.directory, 'attributions.jsonl');
  if (snapshot === undefined && !existsSync(file)) return [];
  if (snapshot === undefined && realpathSync(file) !== file)
    throw new Error('Aliased attribution journal');
  const text = snapshot ?? readFileSync(file, 'utf8');
  if (text && !text.endsWith('\n'))
    throw new Error('Incomplete attribution journal');
  let previous: string | null = null;
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const entry = JSON.parse(l) as Entry;
      if (
        entry.previous !== previous ||
        entry.digest !==
          contentIdentity({ previous, attribution: entry.attribution })
      )
        throw new Error('Attribution identity changed');
      validate(store, entry.attribution);
      previous = entry.digest;
      return entry;
    });
}
function validate(store: RunStore, a: FailureAttribution) {
  assertDigest(a.rubricDigest);
  if (
    store.summary().attempts.every((r) => r.runId !== a.runId) ||
    !causes.includes(a.primary) ||
    a.contributing.some((c) => !causes.includes(c)) ||
    new Set(a.contributing).size !== a.contributing.length ||
    !['high', 'medium', 'low', 'unknown'].includes(a.confidence) ||
    !['unreviewed', 'proposed', 'reviewed', 'disputed'].includes(
      a.adjudication,
    ) ||
    ((a.primary !== 'unknown' || a.adjudication === 'reviewed') &&
      a.evidence.length === 0)
  )
    throw new Error('Attribution requires an attempt and independent evidence');
  for (const entry of a.evidence) {
    assertRelativePath(entry.path);
    assertDigest(entry.sha256);
    const f = path.join(store.directory, entry.path);
    if (realpathSync(f) !== f || sha256(readFileSync(f)) !== entry.sha256)
      throw new Error('Attribution evidence changed');
  }
}
export function appendAttribution(
  store: RunStore,
  attribution: FailureAttribution,
): void {
  validate(store, attribution);
  const lock = path.join(store.directory, '.attribution-lock');
  mkdirSync(lock, { mode: 0o700 });
  try {
    const prior = readAttributions(store);
    const body = { previous: prior.at(-1)?.digest ?? null, attribution };
    appendFileSync(
      path.join(store.directory, 'attributions.jsonl'),
      `${JSON.stringify({ ...body, digest: contentIdentity(body) })}\n`,
      { mode: 0o600 },
    );
  } finally {
    rmSync(lock, { recursive: true });
  }
}
