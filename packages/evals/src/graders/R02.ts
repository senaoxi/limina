import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';
export async function gradeDeclarationConditions(
  task: TaskSpec,
  _fixture: Snapshot,
  _final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const assertions: AssertionReport['assertions'] = [];
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
    const resolved = await run([
      '-e',
      "const ts=require('/opt/limina-evals/runtime/node_modules/typescript');const path=require('path');const input=ts.readConfigFile('tsconfig.consumer.json',ts.sys.readFile);const config=ts.parseJsonConfigFileContent(input.config,ts.sys,process.cwd());const result=ts.resolveModuleName('eval-local-artifact',path.resolve('consumer/index.ts'),config.options,ts.sys).resolvedModule;process.stdout.write(JSON.stringify(result?path.relative(process.cwd(),result.resolvedFileName):null));",
    ]);
    assertions.push({
      id: 'declaration-target-selected',
      passed:
        resolved.exitCode === 0 && resolved.stdout === '"dist/index.d.ts"',
    });
    const graph = await run([cli, 'graph', 'check']);
    assertions.push({ id: 'graph-valid', passed: graph.exitCode === 0 });
    const build = await run([cli, 'checker', 'build']);
    assertions.push({ id: 'consumer-builds', passed: build.exitCode === 0 });
    const references = await run([
      '-e',
      "const fs=require('fs');const manifest=JSON.parse(fs.readFileSync('.limina/manifest.json','utf8'));const file=manifest.checkers.tsc.sourceToDts['tsconfig.consumer.json'];const config=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify(config.references??[]));",
    ]);
    assertions.push({
      id: 'no-source-reference',
      passed: references.exitCode === 0 && references.stdout === '[]',
    });
    const runtime = await run([
      '--input-type=module',
      '-e',
      "import {format} from 'eval-local-artifact';process.stdout.write(JSON.stringify([format(42),format(-7),format(1.25)]));",
    ]);
    assertions.push({
      id: 'runtime-built-api',
      passed: runtime.exitCode === 0 && runtime.stdout === '["42","-7","1.25"]',
    });
    const injection = await run([
      '-e',
      String.raw`require('fs').writeFileSync('consumer/index.ts',"import { format } from 'eval-local-artifact';\nexport const result: number = format(42);\n")`,
    ]);
    const rejected = await run([cli, 'checker', 'build']);
    assertions.push({
      id: 'declaration-diagnostic',
      passed:
        injection.exitCode === 0 &&
        rejected.exitCode === 1 &&
        rejected.stdout.includes('consumer/index.ts(2,14): error TS2322:'),
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
