import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';
const consumptionAssertions = [
  'external-runtime',
  'external-types',
  'external-type-error',
  'missing-transitive-dependency',
];
function hasResolvedDependencies(text: string): boolean {
  try {
    const value = JSON.parse(text).dependencies;
    return (
      value !== null &&
      typeof value === 'object' &&
      Object.keys(value).length === 2 &&
      value['@eval/utility'] === '1.2.3' &&
      value.typescript === '6.0.3'
    );
  } catch {
    return false;
  }
}
function hasSubmittedDependencies(final: Snapshot): boolean {
  const submitted = final.entries.find(
    (value) => value.path === 'packages/app/dist/package.json',
  );
  return (
    submitted?.kind === 'file' &&
    hasResolvedDependencies(
      Buffer.from(submitted.content, 'base64').toString('utf8'),
    )
  );
}

export async function gradePackedDependencies(
  task: TaskSpec,
  _fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const commands: CommandEvidence[] = [];
  const assertions: AssertionReport['assertions'] = [
    {
      id: 'submitted-dependencies',
      passed: hasSubmittedDependencies(final),
    },
  ];
  const run = async (arguments_: string[]) => {
    const result = await verifier.command('/usr/local/bin/node', arguments_);
    commands.push(result);
    return result;
  };
  const setup = await run([
    '-e',
    "const fs=require('fs');fs.symlinkSync('/opt/limina-evals/runtime/node_modules','node_modules');fs.mkdirSync('.eval-tmp/archives',{recursive:true});",
  ]);
  if (setup.exitCode === 0) {
    const checked = await run([
      '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js',
      'package',
      'check',
    ]);
    assertions.push({
      id: 'limina-package-check',
      passed: checked.exitCode === 0,
    });
    const app = await verifier.command('/usr/local/bin/pnpm', [
      '--dir',
      'packages/app/dist',
      'pack',
      '--pack-destination',
      '/workspace/.eval-tmp/archives',
    ]);
    const utility = await verifier.command('/usr/local/bin/pnpm', [
      '--dir',
      'packages/utility/dist',
      'pack',
      '--pack-destination',
      '/workspace/.eval-tmp/archives',
    ]);
    commands.push(app, utility);
    assertions.push({
      id: 'real-pack',
      passed: app.exitCode === 0 && utility.exitCode === 0,
    });
    if (app.exitCode === 0 && utility.exitCode === 0) {
      const manifest = await run([
        '-e',
        "const p=require('child_process').spawnSync('/bin/tar',['-xOf','.eval-tmp/archives/eval-catalog-app-1.0.0.tgz','package/package.json'],{encoding:'utf8'});process.stdout.write(p.stdout??'');process.stderr.write(p.stderr??'');process.exit(p.status??1)",
      ]);
      assertions.push({
        id: 'packed-dependencies',
        passed:
          manifest.exitCode === 0 && hasResolvedDependencies(manifest.stdout),
      });
      const extracted = await run([
        '-e',
        String.raw`
const fs=require('fs'),cp=require('child_process');
const packages=[['eval-catalog-app-1.0.0.tgz','eval-catalog-app'],['eval-utility-1.2.3.tgz','@eval/utility']];
for(const [archive,name] of packages){
  const file='/workspace/.eval-tmp/archives/'+archive;
  const list=cp.spawnSync('/bin/tar',['-tzf',file],{encoding:'utf8'});
  if(list.status!==0)throw Error(list.stderr);
  const entries=list.stdout.trim().split('\n').sort();
  if(JSON.stringify(entries)!==JSON.stringify(['package/index.d.ts','package/index.js','package/package.json']))throw Error('Unexpected archive entries');
  const destination='/tmp/eval-consumer/node_modules/'+name;
  fs.mkdirSync(destination,{recursive:true});
  const extract=cp.spawnSync('/bin/tar',['-xzf',file,'--no-same-owner','--strip-components=1','-C',destination],{encoding:'utf8'});
  if(extract.status!==0)throw Error(extract.stderr);
}
fs.symlinkSync('/opt/limina-evals/runtime/node_modules/typescript','/tmp/eval-consumer/node_modules/typescript');
fs.writeFileSync('/tmp/eval-consumer/package.json',JSON.stringify({type:'module'}));
fs.writeFileSync('/tmp/eval-consumer/index.mjs',"import {total,compilerVersion} from 'eval-catalog-app';process.stdout.write(JSON.stringify([total(2,3),total(-7,4),total(1.25,2.5),compilerVersion]));");
fs.writeFileSync('/tmp/eval-consumer/index.ts',"import {total,compilerVersion} from 'eval-catalog-app';export const value:number=total(2,3);export const version:string=compilerVersion;\n");
fs.writeFileSync('/tmp/eval-consumer/tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,types:[]},files:['index.ts']}));
process.stdout.write('extracted-exact-files');
`,
      ]);
      assertions.push({
        id: 'archive-files',
        passed:
          extracted.exitCode === 0 &&
          extracted.stdout === 'extracted-exact-files',
      });
      if (extracted.exitCode === 0) {
        const runtime = await run(['/tmp/eval-consumer/index.mjs']);
        const tsc = '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc';
        const arguments_ = [
          tsc,
          '-p',
          '/tmp/eval-consumer/tsconfig.json',
          '--pretty',
          'false',
        ];
        const types = await run(arguments_);
        assertions.push(
          {
            id: 'external-runtime',
            passed:
              runtime.exitCode === 0 &&
              runtime.stdout === '[5,-3,3.75,"6.0.3"]',
          },
          { id: 'external-types', passed: types.exitCode === 0 },
        );
        const injected = await run([
          '-e',
          String.raw`require('fs').writeFileSync('/tmp/eval-consumer/index.ts',"import {total} from 'eval-catalog-app';total('wrong',2);\n");`,
        ]);
        const wrong = await run(arguments_);
        assertions.push({
          id: 'external-type-error',
          passed:
            injected.exitCode === 0 &&
            wrong.exitCode === 2 &&
            wrong.stdout.includes('TS2345'),
        });
        const removed = await run([
          '-e',
          "require('fs').rmSync('/tmp/eval-consumer/node_modules/@eval/utility',{recursive:true});",
        ]);
        const missingRuntime = await run(['/tmp/eval-consumer/index.mjs']);
        const missingTypes = await run(arguments_);
        assertions.push({
          id: 'missing-transitive-dependency',
          passed:
            removed.exitCode === 0 &&
            missingRuntime.exitCode === 1 &&
            missingRuntime.stderr.includes('ERR_MODULE_NOT_FOUND') &&
            missingRuntime.stderr.includes('@eval/utility') &&
            missingTypes.exitCode === 2 &&
            missingTypes.stdout.includes('TS2307') &&
            missingTypes.stdout.includes('@eval/utility'),
        });
      } else {
        assertions.push(
          ...consumptionAssertions.map((id) => ({ id, passed: false })),
        );
      }
    } else {
      // A rejected artifact is a task failure. Its dependent assertions are
      // false, not omitted and misclassified as an incomplete Grader report.
      assertions.push(
        ...[
          'packed-dependencies',
          'archive-files',
          ...consumptionAssertions,
        ].map((id) => ({ id, passed: false })),
      );
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
