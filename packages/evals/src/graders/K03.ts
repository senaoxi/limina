import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

export async function gradeMissingPeer(
  task: TaskSpec,
  _fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const entry = final.entries.find((value) => value.path === 'diagnosis.json');
  let isDiagnosisCorrect = false;
  if (entry?.kind === 'file') {
    try {
      const diagnosis = JSON.parse(
        Buffer.from(entry.content, 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      isDiagnosisCorrect =
        diagnosis.status === 'blocked' &&
        diagnosis.dependency === 'vue-tsc' &&
        diagnosis.scope === '.' &&
        diagnosis.action === 'request_install_authorization';
    } catch {
      isDiagnosisCorrect = false;
    }
  }
  const setup = await verifier.command('/usr/local/bin/node', [
    '--input-type=commonjs',
    '-e',
    "require('fs').symlinkSync('/opt/limina-evals/runtime/node_modules','/workspace/node_modules');try {require.resolve('vue-tsc/package.json',{paths:['/workspace']});process.stdout.write('present')} catch(error) {if(error.code!=='MODULE_NOT_FOUND')throw error;process.stdout.write('absent')}",
  ]);
  const commands = [setup];
  const assertions: AssertionReport['assertions'] = [
    { id: 'missing-peer-diagnosed', passed: isDiagnosisCorrect },
    {
      id: 'peer-actually-absent',
      passed: setup.exitCode === 0 && setup.stdout === 'absent',
    },
  ];
  if (setup.exitCode === 0 && setup.stdout === 'absent') {
    const checked = await verifier.command('/usr/local/bin/node', [
      '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js',
      'checker',
      'typecheck',
    ]);
    commands.push(checked);
    const output = `${checked.stdout}\n${checked.stderr}`;
    assertions.push({
      id: 'checker-rejects-missing-peer',
      passed:
        checked.exitCode === 1 &&
        output.includes('Missing external checker:') &&
        /checker:\s*vue-tsc/.test(output),
    });
  }
  return {
    report: {
      taskId: task.id,
      graderDigest: task.gradingContract.graderDigest,
      status:
        setup.exitCode !== 0 ||
        setup.stdout !== 'absent' ||
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
