import type { AssertionReport } from '../../core/outcome.ts';
import type { Snapshot } from '../../core/snapshot.ts';
import type { TaskSpec } from '../../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../../runner/docker-verifier.ts';
import { workflowCommand } from './workflow-command.ts';

const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';

function hasPreservedSource(fixture: Snapshot, final: Snapshot): boolean {
  const source = fixture.entries.find((entry) => entry.path === 'src/index.ts');
  const actualSource = final.entries.find(
    (entry) => entry.path === 'src/index.ts',
  );
  return (
    source?.kind === 'file' &&
    actualSource?.kind === 'file' &&
    source.sha256 === actualSource.sha256
  );
}

/**
Run only after reconstruction and mutation admission, outside the Agent process.
Neither this module nor its assertion decisions are copied into the container.
*/
export async function gradeInitialization(
  task: TaskSpec,
  fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const assertions: AssertionReport['assertions'] = [];
  const commands: CommandEvidence[] = [];
  assertions.push(
    {
      id: 'source-preserved',
      passed: hasPreservedSource(fixture, final),
    },
    {
      id: 'config-created',
      passed: final.entries.some(
        (entry) =>
          entry.kind === 'file' &&
          /^limina\.config\.(?:m?ts|m?js)$/.test(entry.path),
      ),
    },
  );
  const manifest = final.entries.find((entry) => entry.path === 'package.json');
  const packageValue =
    manifest?.kind === 'file'
      ? (JSON.parse(
          Buffer.from(manifest.content, 'base64').toString('utf8'),
        ) as { scripts?: Record<string, unknown> })
      : {};
  const workflows = Object.entries(packageValue.scripts ?? {}).filter(
    ([name, value]) =>
      /^[a-z][\w:.-]*$/iu.test(name) &&
      ['check', 'checker'].includes(workflowCommand(value)?.[0] ?? '') &&
      !Object.hasOwn(packageValue.scripts ?? {}, `pre${name}`) &&
      !Object.hasOwn(packageValue.scripts ?? {}, `post${name}`),
  );
  assertions.push({ id: 'workflow-created', passed: workflows.length > 0 });
  // Dependencies come from the controller-built immutable image, not S1.
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
  const healthyWorkflows: string[] = [];
  for (const [name] of workflows) {
    const result = await verifier.command('/usr/local/bin/pnpm', ['run', name]);
    commands.push(result);
    if (result.exitCode === 0) healthyWorkflows.push(name);
  }
  assertions.push({ id: 'workflow-runs', passed: healthyWorkflows.length > 0 });
  const checked = await verifier.command('/usr/local/bin/node', [
    cli,
    'check',
    '--force',
  ]);
  commands.push(checked);
  assertions.push({
    id: 'full-check',
    passed: checked.exitCode === 0 && !checked.timedOut,
  });
  const injected = await verifier.command('/usr/local/bin/node', [
    '-e',
    `require('fs').writeFileSync('src/index.ts', ${JSON.stringify('export const answer: number = "wrong";\n')})`,
  ]);
  commands.push(injected);
  if (injected.exitCode !== 0 || checked.timedOut || checked.exitCode === null)
    return {
      report: {
        taskId: task.id,
        graderDigest: task.gradingContract.graderDigest,
        status: 'error',
        assertions,
      },
      commands,
    };
  let isWorkflowDetectsError = false;
  for (const name of healthyWorkflows) {
    const result = await verifier.command('/usr/local/bin/pnpm', ['run', name]);
    commands.push(result);
    // Full check summarizes checker failures. The independent compiler below
    // proves the inserted diagnostic; requiring its text here rejects full check.
    if (result.exitCode === 1) isWorkflowDetectsError = true;
  }
  assertions.push({
    id: 'workflow-detects-error',
    passed: isWorkflowDetectsError,
  });
  const rejected = await verifier.command('/usr/local/bin/node', [
    cli,
    'check',
    '--force',
  ]);
  commands.push(rejected);
  const diagnostic = await verifier.command('/usr/local/bin/node', [
    '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc',
    '--project',
    'tsconfig.json',
    '--pretty',
    'false',
    '--noEmit',
  ]);
  commands.push(diagnostic);
  assertions.push({
    id: 'type-error-detected',
    passed:
      injected.exitCode === 0 &&
      rejected.exitCode === 1 &&
      !rejected.timedOut &&
      diagnostic.exitCode === 2 &&
      /src\/index\.ts\(1,\d+\): error TS2322:/.test(diagnostic.stdout),
  });
  return {
    report: {
      taskId: task.id,
      graderDigest: task.gradingContract.graderDigest,
      status:
        commands.some(
          (command) => command.timedOut || command.exitCode === null,
        ) ||
        rejected.timedOut ||
        rejected.exitCode === null ||
        diagnostic.timedOut ||
        diagnostic.exitCode === null
          ? 'error'
          : 'complete',
      assertions,
    },
    commands,
  };
}
