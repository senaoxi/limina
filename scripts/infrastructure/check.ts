import { allowedLicenses } from '@limina/build-tools/license-policy';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { REPO_ROOT } from '../release/shared';

function readYaml(file: string): Record<string, unknown> {
  const document = parseDocument(readFileSync(file, 'utf8'), {
    uniqueKeys: true,
  });
  if (document.errors.length > 0)
    throw new Error(`${file}: ${document.errors.join('; ')}`);
  const result = document.toJS() as Record<string, unknown>;
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error(`Expected YAML mapping: ${file}`);
  return result;
}

function inspectUses(value: unknown, file: string): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'uses') {
      if (typeof child !== 'string') throw new Error(`Invalid uses in ${file}`);
      if (child.startsWith('./')) {
        if (!existsSync(path.join(REPO_ROOT, child, 'action.yml')))
          throw new Error(`Missing local action: ${child}`);
      } else if (!/^[\w.-]+\/[\w./-]+@[a-f\d]{40}$/u.test(child)) {
        throw new Error(
          `External actions must use full immutable commit SHAs: ${child}`,
        );
      }
    }
    inspectUses(child, file);
  }
}

const githubDirectory = path.join(REPO_ROOT, '.github');
for (const directory of ['workflows', 'actions']) {
  const base = path.join(githubDirectory, directory);
  for (const entry of readdirSync(base)) {
    const file =
      directory === 'actions'
        ? path.join(base, entry, 'action.yml')
        : path.join(base, entry);
    if (!file.endsWith('.yml')) continue;
    inspectUses(readYaml(file), file);
  }
}
const policy = readYaml(
  path.join(githubDirectory, 'dependency-review-config.yml'),
);
const licenses = policy['allow-licenses'];
if (
  !Array.isArray(licenses) ||
  JSON.stringify(
    [...licenses].toSorted((a, b) => Number(a > b) - Number(a < b)),
  ) !==
    JSON.stringify(
      [...allowedLicenses].toSorted((a, b) => Number(a > b) - Number(a < b)),
    )
) {
  throw new Error('Dependency review and bundled-license policy disagree.');
}
const ci = readYaml(path.join(githubDirectory, 'workflows/ci.yml'));
const jobs = ci.jobs as Record<string, { needs?: string[] }>;
const expectedJobs = Object.keys(jobs)
  .filter((name) => name !== 'status')
  .toSorted((a, b) => Number(a > b) - Number(a < b));
if (
  JSON.stringify(
    jobs.status?.needs?.toSorted((a, b) => Number(a > b) - Number(a < b)),
  ) !== JSON.stringify(expectedJobs)
) {
  throw new Error('CI Status must depend on every required CI job.');
}
const renovate = JSON.parse(
  readFileSync(path.join(githubDirectory, 'renovate.json'), 'utf8'),
) as { automerge?: boolean };
if (renovate.automerge !== false)
  throw new Error('Dependency updates require review.');
process.stdout.write(
  'Infrastructure configuration: valid YAML, pinned actions, aligned licenses and complete CI aggregation.\n',
);
