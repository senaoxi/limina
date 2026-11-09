import type { AssertionReport } from '../../core/outcome.ts';
import type { Snapshot } from '../../core/snapshot.ts';
import type { TaskSpec } from '../../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../../runner/docker-verifier.ts';

const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';
const tsc = '/opt/limina-evals/runtime/node_modules/typescript/lib/tsc.js';
const runtimeResults = '["42","-7","1.25"]';

export async function gradeDeclarationConditionsV21(
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
    "const fs=require('node:fs'),path=require('node:path');if(!fs.existsSync('node_modules'))fs.symlinkSync('/opt/limina-evals/runtime/node_modules','node_modules');for(const link of JSON.parse(process.argv[1])){fs.mkdirSync(path.dirname(link.path),{recursive:true});if(!fs.existsSync(link.path))fs.symlinkSync(link.target,link.path);}",
    JSON.stringify(task.installPlan.projectLinks ?? []),
  ]);
  if (setup.exitCode === 0) {
    const selected = await run([
      '-e',
      "const ts=require('/opt/limina-evals/runtime/node_modules/typescript'),path=require('node:path');const input=ts.readConfigFile('tsconfig.consumer.json',ts.sys.readFile);const parsed=ts.parseJsonConfigFileContent(input.config,ts.sys,process.cwd());const program=ts.createProgram({rootNames:parsed.fileNames,options:parsed.options,projectReferences:parsed.projectReferences});process.stdout.write(JSON.stringify(program.getSourceFiles().map(file=>path.relative(process.cwd(),file.fileName).split(path.sep).join('/')).filter(file=>file==='src/index.ts'||file==='dist/index.d.ts')));",
    ]);
    assertions.push({
      id: 'declaration-target-selected',
      passed:
        selected.exitCode === 0 && selected.stdout === '["dist/index.d.ts"]',
    });
    for (const [id, arguments_] of [
      ['full-check-valid', ['check']],
      ['graph-valid', ['graph', 'check']],
      ['consumer-builds', ['checker', 'build']],
      ['source-valid', ['source', 'check']],
      ['proof-valid', ['proof', 'check']],
    ] as const) {
      const result = await run([cli, ...arguments_]);
      assertions.push({ id, passed: result.exitCode === 0 });
    }
    const consumer = await run([
      tsc,
      '--noEmit',
      '-p',
      'tsconfig.consumer.json',
      '--pretty',
      'false',
    ]);
    assertions.push({
      id: 'consumer-typechecks',
      passed: consumer.exitCode === 0,
    });
    const references = await run([
      '-e',
      "const fs=require('node:fs');const manifest=JSON.parse(fs.readFileSync('.limina/manifest.json','utf8'));const file=manifest.checkers.tsc.sourceToDts['tsconfig.consumer.json'];const config=JSON.parse(fs.readFileSync(file,'utf8'));process.stdout.write(JSON.stringify(config.references??[]));",
    ]);
    assertions.push({
      id: 'no-source-reference',
      passed: references.exitCode === 0 && references.stdout === '[]',
    });
    const runtime = await run([
      '--input-type=module',
      '-e',
      "import {format} from 'eval-local-artifact';import {result} from './consumer/index.ts';process.stdout.write(JSON.stringify({result,values:[format(42),format(-7),format(1.25)]}));",
    ]);
    assertions.push({
      id: 'runtime-built-api',
      passed:
        runtime.exitCode === 0 &&
        runtime.stdout === `{"result":"42","values":${runtimeResults}}`,
    });
    const external = await run(['runtime-consumer/index.mjs']);
    assertions.push({
      id: 'independent-runtime-consumer',
      passed: external.exitCode === 0 && external.stdout === runtimeResults,
    });
    const invalidConsumer =
      "import { format } from 'eval-local-artifact';\nexport const result: number = format(42);\n";
    const injection = await run([
      '-e',
      `require('node:fs').writeFileSync('consumer/index.ts',${JSON.stringify(invalidConsumer)});`,
    ]);
    const rejected = await run([
      tsc,
      '--noEmit',
      '-p',
      'tsconfig.consumer.json',
      '--pretty',
      'false',
    ]);
    assertions.push({
      id: 'declaration-diagnostic',
      passed:
        injection.exitCode === 0 &&
        rejected.exitCode === 2 &&
        /consumer\/index\.ts\([^)]*\): error TS2322:/u.test(rejected.stdout),
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
