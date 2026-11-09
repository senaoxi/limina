import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

export async function gradeConfigModuleFormat(
  task: TaskSpec,
  fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const original = fixture.entries.find(
    (entry) => entry.path === 'limina.config.js',
  );
  const configs = final.entries.filter((entry) =>
    ['limina.config.mjs', 'limina.config.mts'].includes(entry.path),
  );
  const assertions: AssertionReport['assertions'] = [
    {
      id: 'config-renamed-without-policy-change',
      passed:
        original?.kind === 'file' &&
        configs.length === 1 &&
        configs[0]?.kind === 'file' &&
        configs[0].sha256 === original.sha256 &&
        final.entries.every((entry) => entry.path !== 'limina.config.js'),
    },
  ];
  const setup = await verifier.command('/usr/local/bin/node', [
    '-e',
    "require('fs').symlinkSync('/opt/limina-evals/runtime/node_modules','/workspace/node_modules')",
  ]);
  const commands = [setup];
  if (setup.exitCode !== 0)
    return {
      report: {
        taskId: task.id,
        graderDigest: task.gradingContract.graderDigest,
        status: 'error',
        assertions,
      },
      commands,
    };
  const checked = await verifier.command('/usr/local/bin/node', [
    '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js',
    '--config-loader',
    'native',
    'graph',
    'check',
  ]);
  commands.push(checked);
  assertions.push({
    id: 'native-config-loads',
    passed: checked.exitCode === 0,
  });
  const runtime = await verifier.command('/usr/local/bin/node', [
    '--input-type=commonjs',
    '-e',
    "process.stdout.write(JSON.stringify(require('./runtime.js')))",
  ]);
  commands.push(runtime);
  assertions.push({
    id: 'commonjs-consumer-preserved',
    passed: runtime.exitCode === 0 && runtime.stdout === '{"answer":42}',
  });
  return {
    report: {
      taskId: task.id,
      graderDigest: task.gradingContract.graderDigest,
      status: commands.some(
        (command) => command.timedOut || command.exitCode === null,
      )
        ? 'error'
        : 'complete',
      assertions,
    },
    commands,
  };
}
