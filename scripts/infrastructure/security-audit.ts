import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from '../release/shared';
import { analyzeAuditOutput, formatAuditReport } from './audit';

const outputDirectory = path.join(REPO_ROOT, '.reports/security');
await mkdir(outputDirectory, { recursive: true });
await rm(path.join(outputDirectory, 'audit.json'), { force: true });
try {
  const pnpmEntry = process.env.npm_execpath;
  if (!pnpmEntry)
    throw new Error('Run the audit through pnpm run security:audit.');
  const result = spawnSync(process.execPath, [pnpmEntry, 'audit', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  await writeFile(
    path.join(outputDirectory, 'audit.raw.json'),
    result.stdout ?? '',
  );
  if (result.error || result.signal || result.status === null) {
    throw (
      result.error ??
      new Error(`Audit terminated: ${result.signal ?? 'unknown exit'}`)
    );
  }
  const report = analyzeAuditOutput(result.stdout, result.status);
  await writeFile(
    path.join(outputDirectory, 'audit.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    path.join(outputDirectory, 'README.md'),
    formatAuditReport(report),
  );
  process.stdout.write(formatAuditReport(report));
  if (report.failed) process.exitCode = 1;
} catch (error) {
  await writeFile(
    path.join(outputDirectory, 'README.md'),
    '# Dependency audit\n\nFAIL: audit report is unavailable or invalid. Inspect the command log and raw report.\n',
  );
  throw error;
}
