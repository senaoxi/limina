import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';
const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';
function isDiagnosisCorrect(snapshot: Snapshot): boolean {
  try {
    const entry = snapshot.entries.find(
      (value) => value.path === 'diagnosis.json',
    );
    if (entry?.kind !== 'file') return false;
    const value = JSON.parse(
      Buffer.from(entry.content, 'base64').toString('utf8'),
    );
    return (
      value.initialRunSucceeded === false &&
      value.retainedManifestProvesCurrentSuccess === false &&
      value.cause === 'invalid-scope-source-include' &&
      value.repair === 'configuration' &&
      value.rerun === 'graph-and-checker'
    );
  } catch {
    return false;
  }
}
export async function gradeStaleManifest(
  task: TaskSpec,
  _fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const assertions: AssertionReport['assertions'] = [
    { id: 'failure-diagnosis', passed: isDiagnosisCorrect(final) },
  ];
  const commands: CommandEvidence[] = [];
  const run = async (arguments_: string[]) => {
    const result = await verifier.command('/usr/local/bin/node', arguments_);
    commands.push(result);
    return result;
  };
  const setup = await run([
    '-e',
    "const fs=require('fs');fs.symlinkSync('/opt/limina-evals/runtime/node_modules','node_modules');fs.rmSync('.limina',{recursive:true,force:true});",
  ]);
  const submitted = final.entries.find(
    (value) => value.path === 'limina.config.mjs',
  );
  if (setup.exitCode === 0 && submitted?.kind === 'file') {
    const policy = await run([
      '--input-type=module',
      '-e',
      "import config from './limina.config.mjs';process.stdout.write(JSON.stringify(config));",
    ]);
    assertions.push({
      id: 'governance-preserved',
      passed:
        policy.exitCode === 0 &&
        policy.stdout === '{"scope":{"source":{"include":["src/**/*.ts"]}}}',
    });
    const graph = await run([cli, 'graph', 'prepare']);
    const build = await run([cli, 'checker', 'build']);
    assertions.push(
      { id: 'fresh-graph', passed: graph.exitCode === 0 },
      { id: 'fresh-checker', passed: build.exitCode === 0 },
    );
    const injected = await run([
      '-e',
      String.raw`require('fs').writeFileSync('src/index.ts','export const answer: number = "wrong";\n');`,
    ]);
    const rejected = await run([cli, 'checker', 'build']);
    assertions.push({
      id: 'real-diagnostic',
      passed:
        injected.exitCode === 0 &&
        rejected.exitCode === 1 &&
        `${rejected.stdout}\n${rejected.stderr}`.includes(
          'src/index.ts(1,14): error TS2322:',
        ),
    });
    const before = await run([
      '-e',
      "process.stdout.write(require('fs').readFileSync('.limina/manifest.json','utf8'))",
    ]);
    const invalid = await run([
      '-e',
      String.raw`const fs=require('fs');fs.writeFileSync('src/index.ts','export const answer: number = 42;\n');fs.writeFileSync('limina.config.mjs','export default { scope: { source: { include: [42] } } };\n');`,
    ]);
    const failed = await run([cli, 'graph', 'prepare']);
    const after = await run([
      '-e',
      "process.stdout.write(require('fs').readFileSync('.limina/manifest.json','utf8'))",
    ]);
    let hasCompleteManifest = false;
    try {
      hasCompleteManifest = JSON.parse(before.stdout).purpose === 'complete';
    } catch {
      /*
      Missing evidence remains false.
      */
    }
    assertions.push({
      id: 'failed-config-retains-old-manifest',
      passed:
        before.exitCode === 0 &&
        after.exitCode === 0 &&
        before.stdout === after.stdout &&
        hasCompleteManifest &&
        invalid.exitCode === 0 &&
        failed.exitCode === 1 &&
        failed.stderr.includes('scope.source.include[0]'),
    });
    const restored = await run([
      '-e',
      `require('fs').writeFileSync('limina.config.mjs',Buffer.from(${JSON.stringify(submitted.content)},'base64'));`,
    ]);
    const recovered = await run([cli, 'checker', 'build']);
    assertions.push({
      id: 'recovery-after-failure',
      passed: restored.exitCode === 0 && recovered.exitCode === 0,
    });
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
