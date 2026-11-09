import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';
export async function gradePublicEntry(
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
    "const fs=require('fs');fs.symlinkSync('/opt/limina-evals/runtime/node_modules','node_modules');fs.mkdirSync('packages/app/node_modules/@eval',{recursive:true});fs.symlinkSync('../../../math','packages/app/node_modules/@eval/math');",
  ]);
  if (setup.exitCode === 0) {
    const imports = await run([
      '-e',
      "const fs=require('fs'),ts=require('/opt/limina-evals/runtime/node_modules/typescript');const source=ts.createSourceFile('index.ts',fs.readFileSync('packages/app/src/index.ts','utf8'),ts.ScriptTarget.Latest,true);process.stdout.write(JSON.stringify(source.statements.filter(ts.isImportDeclaration).map(n=>ts.isStringLiteral(n.moduleSpecifier)?n.moduleSpecifier.text:null))); ",
    ]);
    assertions.push({
      id: 'public-static-import',
      passed: imports.exitCode === 0 && imports.stdout === '["@eval/math"]',
    });
    const source = await run([cli, 'source', 'check']);
    const build = await run([cli, 'checker', 'build']);
    assertions.push(
      { id: 'source-check-passes', passed: source.exitCode === 0 },
      { id: 'checker-builds', passed: build.exitCode === 0 },
    );
    const runtimeArguments = [
      '--input-type=module',
      '-e',
      "import {total} from './packages/app/src/index.ts';process.stdout.write(JSON.stringify([total(2,3),total(-7,4),total(1.25,2.5),total(0,0)]));",
    ];
    const runtime = await run(runtimeArguments);
    assertions.push({
      id: 'runtime-preserved',
      passed: runtime.exitCode === 0 && runtime.stdout === '[5,-3,3.75,0]',
    });
    // A copied implementation can pass all original examples. A fresh process
    // with a changed provider proves that the app actually delegates to it.
    const changed = await run([
      '-e',
      String.raw`require('fs').writeFileSync('packages/math/src/index.ts','export function add(a: number, b: number): number { return a * 13 - b * 7 + 19; }\n');`,
    ]);
    const delegated = await run(runtimeArguments);
    assertions.push({
      id: 'provider-delegation',
      passed:
        changed.exitCode === 0 &&
        delegated.exitCode === 0 &&
        delegated.stdout === '[24,-100,17.75,19]',
    });
    const relative = await run([
      '-e',
      String.raw`require('fs').writeFileSync('packages/app/src/index.ts',"import { add } from '../../math/src/index.ts';\nexport const total = (a: number, b: number): number => add(a, b);\n");`,
    ]);
    const denied = await run([cli, 'source', 'check']);
    assertions.push({
      id: 'relative-boundary-rejected',
      passed:
        relative.exitCode === 0 &&
        denied.exitCode === 1 &&
        `${denied.stdout}\n${denied.stderr}`.includes(
          'LIMINA_SOURCE_RELATIVE_IMPORT_ESCAPES_SCOPE',
        ),
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
