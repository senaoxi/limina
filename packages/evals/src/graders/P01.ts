import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

export async function gradePackageExports(
  task: TaskSpec,
  _fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const commands: CommandEvidence[] = [];
  const assertions: AssertionReport['assertions'] = [];
  const execute = async (arguments_: string[]) => {
    const result = await verifier.command('/usr/local/bin/node', arguments_);
    commands.push(result);
    return result;
  };
  const setup = await execute([
    '-e',
    "require('fs').symlinkSync('/opt/limina-evals/runtime/node_modules','/workspace/node_modules')",
  ]);
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
  const build = await execute(['build.mjs']);
  assertions.push({ id: 'fresh-build', passed: build.exitCode === 0 });
  const builtFiles = await execute([
    '--input-type=commonjs',
    '-e',
    "const fs=require('fs');const crypto=require('crypto');const files=[];function walk(root){for(const entry of fs.readdirSync(root,{withFileTypes:true})){const file=root+'/'+entry.name;if(entry.isDirectory())walk(file);else if(entry.isFile())files.push([file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);else throw Error('Unexpected built file type');}}walk('dist');process.stdout.write(JSON.stringify(files.sort()));",
  ]);
  const submittedFiles = final.entries
    .filter((entry) => entry.path.startsWith('dist/') && entry.kind === 'file')
    .map((entry) => [entry.path, entry.kind === 'file' ? entry.sha256 : ''])
    .toSorted((a, b) => Buffer.compare(Buffer.from(a[0]!), Buffer.from(b[0]!)));
  let isSubmittedOutputCorrect: boolean;
  try {
    isSubmittedOutputCorrect =
      builtFiles.exitCode === 0 &&
      final.entries.some((entry) => entry.path === 'dist') &&
      JSON.stringify(submittedFiles) ===
        JSON.stringify(JSON.parse(builtFiles.stdout));
  } catch {
    isSubmittedOutputCorrect = false;
  }
  assertions.push({
    id: 'submitted-output-matches-build',
    passed: isSubmittedOutputCorrect,
  });
  const checked = await execute([
    '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js',
    'package',
    'check',
    '--package',
    'eval-exports-lib',
  ]);
  assertions.push({
    id: 'package-boundary-check',
    passed: checked.exitCode === 0,
  });
  const consumer = await execute([
    '--input-type=commonjs',
    '-e',
    String.raw`
const fs=require('fs');const path=require('path');
const manifest=JSON.parse(fs.readFileSync('dist/package.json','utf8'));const entry=manifest.exports?.['.'];
const valid=(target,suffix)=>typeof target==='string'&&target.startsWith('./')&&target.endsWith(suffix)&&path.resolve('dist',target).startsWith(path.resolve('dist')+path.sep)&&fs.existsSync(path.resolve('dist',target));
fs.mkdirSync('consumer/node_modules',{recursive:true});fs.symlinkSync('../../dist','consumer/node_modules/eval-exports-lib');
fs.writeFileSync('consumer/package.json',JSON.stringify({type:'module'}));
fs.writeFileSync('consumer/index.mjs',"import {add} from 'eval-exports-lib';process.stdout.write(JSON.stringify([add(2,3),add(-7,5),add(1.25,2.25)]));");
fs.writeFileSync('consumer/index.ts',"import {add} from 'eval-exports-lib';export const value:number=add(2,3);\n");
fs.writeFileSync('consumer/tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,types:[]},files:['index.ts']}));
process.stdout.write(JSON.stringify({validTargets:valid(entry?.types,'.d.ts')&&valid(entry?.import,'.js')}));
`,
  ]);
  let hasValidTargets: boolean;
  try {
    hasValidTargets =
      consumer.exitCode === 0 &&
      JSON.parse(consumer.stdout).validTargets === true;
  } catch {
    hasValidTargets = false;
  }
  assertions.push({ id: 'built-export-targets', passed: hasValidTargets });
  const runtime = await execute(['consumer/index.mjs']);
  assertions.push({
    id: 'runtime-consumption',
    passed: runtime.exitCode === 0 && runtime.stdout === '[5,-2,3.5]',
  });
  const tsc = '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc';
  const types = await execute([
    tsc,
    '-p',
    'consumer/tsconfig.json',
    '--pretty',
    'false',
  ]);
  assertions.push({ id: 'type-consumption', passed: types.exitCode === 0 });
  const inject = await execute([
    '-e',
    String.raw`require('fs').writeFileSync('consumer/index.ts',"import {add} from 'eval-exports-lib';add('wrong',1);\n");`,
  ]);
  const wrong = await execute([
    tsc,
    '-p',
    'consumer/tsconfig.json',
    '--pretty',
    'false',
  ]);
  assertions.push({
    id: 'type-error-detected',
    passed:
      inject.exitCode === 0 &&
      wrong.exitCode === 2 &&
      wrong.stdout.includes('TS2345'),
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
