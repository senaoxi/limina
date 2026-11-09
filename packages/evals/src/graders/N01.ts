import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

export async function gradeTypescriptRepair(
  task: TaskSpec,
  _fixture: Snapshot,
  _final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const commands: CommandEvidence[] = [];
  const compiled = await verifier.command('/usr/local/bin/node', [
    '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc',
    '--project',
    'tsconfig.json',
    '--pretty',
    'false',
  ]);
  commands.push(compiled);
  const assertions: AssertionReport['assertions'] = [
    {
      id: 'compiler-accepts',
      passed: compiled.exitCode === 0 && !compiled.timedOut,
    },
  ];
  let isRuntimeCorrect = false;
  let hasRuntimeInfrastructureError = false;
  if (compiled.exitCode === 0) {
    const names = [
      'Mira',
      '  Chen  ',
      '',
      '\t\n ',
      '李 小明',
      'Ada, PhD!',
      ' 🌱 ',
    ];
    const runtime = await verifier.command('/usr/local/bin/node', [
      '--input-type=module',
      '-e',
      "const names=JSON.parse(process.argv[1]);const {greet}=await import('./dist/greet.js');const values=names.map(name=>greet(name));process.stdout.write(JSON.stringify(values));",
      JSON.stringify(names),
    ]);
    commands.push(runtime);
    hasRuntimeInfrastructureError =
      runtime.timedOut || runtime.exitCode === null;
    try {
      const actual: unknown = JSON.parse(runtime.stdout);
      const expected = names.map(
        (name) => `Hello, ${name.trim() || 'stranger'}`,
      );
      isRuntimeCorrect =
        runtime.exitCode === 0 &&
        runtime.stderr === '' &&
        JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
      isRuntimeCorrect = false;
    }
  }
  assertions.push({ id: 'runtime-semantics', passed: isRuntimeCorrect });
  return {
    report: {
      taskId: task.id,
      graderDigest: task.gradingContract.graderDigest,
      status:
        hasRuntimeInfrastructureError ||
        compiled.timedOut ||
        compiled.exitCode === null
          ? 'error'
          : 'complete',
      assertions,
    },
    commands,
  };
}
