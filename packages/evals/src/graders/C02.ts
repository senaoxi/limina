import path from 'node:path';
import { contentIdentity } from '../core/identity.ts';
import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';
function readJson(
  snapshot: Snapshot,
  file: string,
): Record<string, unknown> | undefined {
  const entry = snapshot.entries.find((value) => value.path === file);
  if (entry?.kind !== 'file') return undefined;
  try {
    return JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}
function references(
  value: Record<string, unknown> | undefined,
  directory: string,
): string[] {
  return Array.isArray(value?.references)
    ? value.references
        .map((reference: unknown) =>
          reference &&
          typeof reference === 'object' &&
          'path' in reference &&
          typeof reference.path === 'string'
            ? path.posix.normalize(
                path.posix.join(
                  directory,
                  reference.path,
                  reference.path.endsWith('.json') ? '' : 'tsconfig.json',
                ),
              )
            : '<invalid>',
        )
        .toSorted((left, right) => left.localeCompare(right))
    : [];
}
export async function gradeEntryCoverage(
  task: TaskSpec,
  fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const wrapper = readJson(final, 'api/tsconfig.json');
  const original = readJson(fixture, 'api/tsconfig.solution.json');
  const assertions: AssertionReport['assertions'] = [
    {
      id: 'solution-structure-preserved',
      passed:
        JSON.stringify(references(readJson(final, 'tsconfig.json'), '.')) ===
          JSON.stringify(['api/tsconfig.json', 'client/tsconfig.json']) &&
        wrapper !== undefined &&
        original !== undefined &&
        contentIdentity({
          ...wrapper,
          references: references(wrapper, 'api'),
        }) ===
          contentIdentity({
            ...original,
            references: references(original, 'api'),
          }) &&
        final.entries.every(
          (value) => value.path !== 'api/tsconfig.solution.json',
        ),
    },
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
    const checked = await run([cli, 'checker', 'build']);
    assertions.push({
      id: 'both-leaves-typecheck',
      passed: checked.exitCode === 0,
    });
    const manifest = await run([
      '-e',
      "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('.limina/manifest.json','utf8')).checkers.tsc.roots.sort()))",
    ]);
    assertions.push({
      id: 'both-leaves-owned',
      passed:
        manifest.exitCode === 0 &&
        manifest.stdout ===
          JSON.stringify([
            'api/tsconfig.lib.json',
            'api/tsconfig.test.json',
            'client/tsconfig.app.json',
            'client/tsconfig.test.json',
          ]),
    });
    for (const [name, config] of [
      ['client', 'tsconfig.app.json'],
      ['api', 'tsconfig.lib.json'],
    ] as const) {
      const file = `${name}/index.ts`;
      const saved = final.entries.find((entry) => entry.path === file);
      const injected = await run([
        '-e',
        String.raw`require('fs').writeFileSync(${JSON.stringify(file)},'export const injected: number = "not a number";\n')`,
      ]);
      const rejected = await run([cli, 'checker', 'build']);
      const diagnostic = await run([
        '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc',
        '-p',
        `${name}/${config}`,
        '--pretty',
        'false',
        '--noEmit',
      ]);
      assertions.push({
        id: `${name}-diagnostic`,
        passed:
          injected.exitCode === 0 &&
          rejected.exitCode === 1 &&
          rejected.stdout.includes(`${file}(1,14): error TS2322:`) &&
          diagnostic.exitCode === 2 &&
          diagnostic.stdout.includes(`${file}(1,14): error TS2322:`),
      });
      if (saved?.kind === 'file')
        await run([
          '-e',
          `require('fs').writeFileSync(${JSON.stringify(file)},Buffer.from(${JSON.stringify(saved.content)},'base64'))`,
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
