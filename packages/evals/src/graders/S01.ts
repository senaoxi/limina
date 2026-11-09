import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';
const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';
function isDeclarationCorrect(snapshot: Snapshot): boolean {
  const read = (path: string) => {
    const entry = snapshot.entries.find((value) => value.path === path);
    if (entry?.kind !== 'file') throw new Error('Missing manifest');
    return JSON.parse(
      Buffer.from(entry.content, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
  };
  try {
    const root = read('package.json');
    const app = read('packages/app/package.json');
    return (
      root.dependencies === undefined &&
      JSON.stringify(app.dependencies) ===
        JSON.stringify({ typescript: '6.0.3' })
    );
  } catch {
    return false;
  }
}
export async function gradeDependencyOwner(
  task: TaskSpec,
  _fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const assertions: AssertionReport['assertions'] = [
    { id: 'owner-declaration-only', passed: isDeclarationCorrect(final) },
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
    const source = await run([cli, 'source', 'check']);
    assertions.push({
      id: 'source-check-passes',
      passed: source.exitCode === 0,
    });
    const build = await run([cli, 'checker', 'build']);
    assertions.push({ id: 'checker-builds', passed: build.exitCode === 0 });
    const runtime = await run([
      '--input-type=module',
      '-e',
      "import {compilerVersion} from './packages/app/src/index.ts';process.stdout.write(compilerVersion)",
    ]);
    assertions.push({
      id: 'runtime-preserved',
      passed: runtime.exitCode === 0 && runtime.stdout === '6.0.3',
    });
    const wrongOwner = await run([
      '-e',
      "const fs=require('fs'),file='packages/app/package.json',app=JSON.parse(fs.readFileSync(file,'utf8')),root=JSON.parse(fs.readFileSync('package.json','utf8'));delete app.dependencies;root.dependencies={typescript:'6.0.3'};fs.writeFileSync(file,JSON.stringify(app));fs.writeFileSync('package.json',JSON.stringify(root));",
    ]);
    const denied = await run([cli, 'source', 'check']);
    const output = `${denied.stdout}\n${denied.stderr}`;
    assertions.push({
      id: 'wrong-owner-rejected',
      passed:
        wrongOwner.exitCode === 0 &&
        denied.exitCode === 1 &&
        output.includes('Unauthorized bare package import:') &&
        output.includes('source owner: packages/app/package.json') &&
        output.includes('imported specifier: typescript'),
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
