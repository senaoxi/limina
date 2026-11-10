import type { TaskDefinition } from '../../controller/calibration.ts';
import { gradeTypescriptRepair } from '../N01.ts';

/**
Compile a separate client against the emitted declaration, never the implementation's own assertions.
*/
export const gradeTypescriptApi: TaskDefinition['grade'] = async (
  task,
  fixture,
  final,
  verifier,
) => {
  const graded = await gradeTypescriptRepair(task, fixture, final, verifier);
  const arguments_ = [
    '--project',
    'tsconfig.json',
    '--pretty',
    'false',
    '--declaration',
    '--emitDeclarationOnly',
  ];
  const emitted = await verifier.command('/usr/local/bin/node', [
    '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc',
    ...arguments_,
  ]);
  graded.commands.push(emitted);
  const setup = await verifier.command('/usr/local/bin/node', [
    '-e',
    String.raw`const fs=require('fs');fs.mkdirSync('/tmp/eval-api',{recursive:true});fs.writeFileSync('/tmp/eval-api/client.ts',"import {greet} from '/workspace/dist/greet.js';\ndeclare const name:string;\nexport const result:string=greet(name);\nexport const call:(name:string)=>string=greet;\ntype Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;\nconst exact:Equal<typeof greet,(name:string)=>string>=true;\nexport {exact};\n");fs.writeFileSync('/tmp/eval-api/tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,types:[]},files:['client.ts']}));fs.writeFileSync('/tmp/eval-api/package.json','{"type":"module"}');`,
  ]);
  graded.commands.push(setup);
  const checked = await verifier.command('/usr/local/bin/node', [
    '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc',
    '-p',
    '/tmp/eval-api/tsconfig.json',
    '--pretty',
    'false',
  ]);
  graded.commands.push(checked);
  graded.report.assertions.push({
    id: 'public-types-preserved',
    passed:
      emitted.exitCode === 0 && setup.exitCode === 0 && checked.exitCode === 0,
  });
  if ([emitted, setup, checked].some((c) => c.timedOut || c.exitCode === null))
    graded.report.status = 'error';
  return graded;
};
