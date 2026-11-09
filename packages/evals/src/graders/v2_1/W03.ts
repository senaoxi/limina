import path from 'node:path';
import type { AssertionReport } from '../../core/outcome.ts';
import type { Snapshot } from '../../core/snapshot.ts';
import type { TaskSpec } from '../../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../../runner/docker-verifier.ts';
const snapshotScript =
  "const fs=require('fs'),crypto=require('crypto'),entries=[];function visit(p){if(p==='node_modules')return;const s=fs.lstatSync(p||'.');if(s.isDirectory()){if(p)entries.push({path:p,kind:'directory',mode:s.mode&4095});for(const n of fs.readdirSync(p||'.').sort())visit(p?p+'/'+n:n)}else if(s.isFile())entries.push({path:p,kind:'file',mode:s.mode&4095,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')});else entries.push({path:p,kind:'link',target:fs.readlinkSync(p)})}visit('');process.stdout.write(JSON.stringify(entries));";
function isReportCorrect(snapshot: Snapshot): boolean {
  const entry = snapshot.entries.find(
    (value) => value.path === 'migration-report.json',
  );
  if (entry?.kind !== 'file') return false;
  try {
    const report = JSON.parse(
      Buffer.from(entry.content, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const hasPaths = (key: string, expected: string[]) => {
      const values = report[key];
      return (
        Array.isArray(values) &&
        values.every((value) => typeof value === 'string') &&
        JSON.stringify(
          values.toSorted((left, right) => left.localeCompare(right)),
        ) === JSON.stringify(expected)
      );
    };
    return (
      report.status === 'preview_complete' &&
      typeof report.scope === 'string' &&
      report.scope.length > 0 &&
      !path.posix.isAbsolute(report.scope) &&
      !report.scope.split('/').includes('..') &&
      path.posix.resolve('/workspace', report.scope) === '/workspace' &&
      report.migrationApplied === false &&
      report.auditWritten === false &&
      report.diskVerification === 'not_run' &&
      hasPaths('create', ['limina.config.mjs']) &&
      hasPaths('update', ['tsconfig.json']) &&
      hasPaths('isolated', ['bad/tsconfig.json'])
    );
  } catch {
    return false;
  }
}
export async function gradeMigrationPreview(
  task: TaskSpec,
  _fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const assertions: AssertionReport['assertions'] = [
    { id: 'preview-report-correct', passed: isReportCorrect(final) },
  ];
  const commands: CommandEvidence[] = [];
  const run = async (arguments_: string[]) => {
    const result = await verifier.command('/usr/local/bin/node', arguments_);
    commands.push(result);
    return result;
  };
  const setup = await run([
    '-e',
    "require('fs').symlinkSync('/opt/limina-evals/runtime/node_modules','/workspace/node_modules')",
  ]);
  if (setup.exitCode === 0) {
    const before = await run(['-e', snapshotScript]);
    const preview = await run([
      '/opt/limina-evals/runtime/node_modules/limina-migrate/bin/limina-migrate.js',
      '--yes',
      '--dry-run',
    ]);
    const after = await run(['-e', snapshotScript]);
    assertions.push(
      {
        id: 'actual-preview-complete',
        passed:
          preview.exitCode === 0 &&
          preview.stdout.includes(
            'Migration preview complete; no migration files were written',
          ),
      },
      {
        id: 'actual-planned-files',
        passed:
          preview.stdout.includes(
            'create: 1; update: 1; total planned files: 2',
          ) &&
          preview.stdout.includes('create: limina.config.mjs') &&
          preview.stdout.includes('update: tsconfig.json') &&
          preview.stdout.includes('isolated, preserved: bad/tsconfig.json'),
      },
      {
        id: 'no-migration-writes',
        passed:
          before.exitCode === 0 &&
          after.exitCode === 0 &&
          before.stdout === after.stdout,
      },
    );
    const audit = await run([
      '-e',
      "process.stdout.write(String(require('fs').existsSync('.limina/migration/latest.json')))",
    ]);
    assertions.push(
      {
        id: 'no-applied-audit',
        passed:
          audit.exitCode === 0 &&
          audit.stdout === 'false' &&
          final.entries.every(
            (entry) => entry.path !== '.limina/migration/latest.json',
          ),
      },
      {
        id: 'preview-is-not-disk-verification',
        passed: preview.stdout.includes(
          'Preview: disk verification and all migration-controlled writes are disabled.',
        ),
      },
    );
  }
  return {
    report: {
      taskId: task.id,
      graderDigest: task.gradingContract.graderDigest,
      status:
        setup.exitCode !== 0 ||
        commands.some(
          (command) => command.timedOut || command.exitCode === null,
        )
          ? 'error'
          : 'complete',
      assertions,
    },
    commands,
  };
}
