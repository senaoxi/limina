import path from 'node:path';
import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';
export async function gradeExcludedClosure(
  task: TaskSpec,
  fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const sourceConfig = fixture.entries.find(
    (entry) => entry.path === 'limina.config.mjs',
  );
  const finalConfig = final.entries.find(
    (entry) => entry.path === 'limina.config.mjs',
  );
  const root = final.entries.find((entry) => entry.path === 'tsconfig.json');
  let isComplete = false;
  if (root?.kind === 'file') {
    try {
      const config = JSON.parse(
        Buffer.from(root.content, 'base64').toString('utf8'),
      ) as { references?: { path?: unknown }[] };
      const references = config.references
        ?.map((reference) =>
          typeof reference.path === 'string'
            ? path.posix.normalize(
                path.posix.join(
                  reference.path,
                  reference.path.endsWith('.json') ? '' : 'tsconfig.json',
                ),
              )
            : '<invalid>',
        )
        .toSorted((left, right) => left.localeCompare(right));
      isComplete =
        JSON.stringify(references) ===
        JSON.stringify(['checks/tsconfig.json', 'lib/tsconfig.json']);
    } catch {
      isComplete = false;
    }
  }
  const assertions: AssertionReport['assertions'] = [
    {
      id: 'entry-exclusion-preserved',
      passed:
        sourceConfig?.kind === 'file' &&
        finalConfig?.kind === 'file' &&
        sourceConfig.sha256 === finalConfig.sha256,
    },
    { id: 'complete-solution-references', passed: isComplete },
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
    const graph = await run([cli, 'graph', 'check']);
    assertions.push({ id: 'graph-valid', passed: graph.exitCode === 0 });
    const proof = await run([cli, 'proof', 'check']);
    assertions.push({ id: 'proof-valid', passed: proof.exitCode === 0 });
    const build = await run([cli, 'checker', 'build']);
    assertions.push({ id: 'closure-built', passed: build.exitCode === 0 });
    const manifest = await run([
      '-e',
      "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('.limina/manifest.json','utf8')).checkers.tsc.roots.sort()))",
    ]);
    assertions.push({
      id: 'both-leaves-owned',
      passed:
        manifest.exitCode === 0 &&
        manifest.stdout ===
          JSON.stringify(['checks/tsconfig.json', 'lib/tsconfig.json']),
    });
    for (const [directory, assertion] of [
      ['checks', 'excluded-leaf-diagnostic'],
      ['lib', 'existing-leaf-diagnostic'],
    ] as const) {
      const file = `${directory}/index.ts`;
      const original = final.entries.find((entry) => entry.path === file);
      const injection = await run([
        '-e',
        String.raw`require('fs').writeFileSync(${JSON.stringify(file)},'export const injected: number = "bad";\n')`,
      ]);
      const rejected = await run([cli, 'checker', 'build']);
      const diagnostic = await run([
        '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc',
        '-p',
        `${directory}/tsconfig.json`,
        '--pretty',
        'false',
        '--noEmit',
      ]);
      assertions.push({
        id: assertion,
        passed:
          injection.exitCode === 0 &&
          rejected.exitCode === 1 &&
          rejected.stdout.includes(`${file}(1,14): error TS2322:`) &&
          diagnostic.exitCode === 2 &&
          diagnostic.stdout.includes(`${file}(1,14): error TS2322:`),
      });
      if (original?.kind === 'file')
        await run([
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(file)},Buffer.from(${JSON.stringify(original.content)},'base64'))`,
        ]);
    }
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
