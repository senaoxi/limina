import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';

export async function gradeConfigRule(
  task: TaskSpec,
  fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const commands: CommandEvidence[] = [];
  const isPreserved = [
    'app/node.ts',
    'app/runtime.ts',
    'limina.config.mts',
  ].every((file) => {
    const expected = fixture.entries.find((entry) => entry.path === file);
    const actual = final.entries.find((entry) => entry.path === file);
    return (
      expected?.kind === 'file' &&
      actual?.kind === 'file' &&
      expected.sha256 === actual.sha256
    );
  });
  const assertions: AssertionReport['assertions'] = [
    { id: 'governance-preserved', passed: isPreserved },
  ];
  const setup = await verifier.command('/usr/local/bin/node', [
    '-e',
    "require('fs').symlinkSync('/opt/limina-evals/runtime/node_modules','/workspace/node_modules')",
  ]);
  commands.push(setup);
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
  const denied = await verifier.command('/usr/local/bin/node', [
    cli,
    'graph',
    'check',
  ]);
  commands.push(denied);
  const invocation = /^Standalone issue invocation: ([a-f\d-]{36})$/m.exec(
    denied.stdout,
  )?.[1];
  let hasDeniedReference = false;
  if (invocation) {
    const issues = await verifier.command('/usr/local/bin/node', [
      cli,
      'check',
      '--issues',
      '--invocation',
      invocation,
      '--format',
      'json',
    ]);
    commands.push(issues);
    try {
      const result = JSON.parse(issues.stdout) as {
        issues?: {
          code?: string;
          filePath?: string;
          evidence?: { label?: string; value?: string }[];
        }[];
      };
      hasDeniedReference =
        issues.exitCode === 0 &&
        result.issues?.some(
          (issue) =>
            issue.code === 'LIMINA_GRAPH_ACCESS_DENIED' &&
            issue.filePath === 'app/runtime.ts' &&
            issue.evidence?.some(
              (evidence) =>
                evidence.label === 'denied reference' &&
                evidence.value ===
                  '/workspace/.limina/tsconfig/checkers/tsc/projects/app/tsconfig.node.dts.json',
            ),
        ) === true;
    } catch {
      hasDeniedReference = false;
    }
  }
  assertions.push({
    id: 'rule-rejects-forbidden-reference',
    passed: denied.exitCode === 1 && hasDeniedReference,
  });
  const control = await verifier.command('/usr/local/bin/node', [
    '-e',
    String.raw`const fs=require('fs');const file='app/tsconfig.runtime.json';const config=JSON.parse(fs.readFileSync(file,'utf8'));delete config.references;fs.writeFileSync(file,JSON.stringify(config));fs.writeFileSync('app/runtime.ts','export const runtimeValue = 1;\n');`,
  ]);
  commands.push(control);
  if (control.exitCode !== 0)
    return {
      report: {
        taskId: task.id,
        graderDigest: task.gradingContract.graderDigest,
        status: 'error',
        assertions,
      },
      commands,
    };
  const allowed = await verifier.command('/usr/local/bin/node', [
    cli,
    'graph',
    'check',
  ]);
  commands.push(allowed);
  assertions.push({
    id: 'rule-allows-unrelated-project',
    passed: allowed.exitCode === 0 && !allowed.timedOut,
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
