import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';
function liminaArguments(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return undefined;
  const command = value
    .replaceAll(/^[ \t]+|[ \t]+$/g, '')
    .replace(/^pnpm[ \t]+exec[ \t]+/, '');
  if (/^limina[ \t]+checker[ \t]+build$/.test(command))
    return ['checker', 'build'];
  return /^limina[ \t]+build[ \t]+(?:"(?:\.\/)?tsconfig\.json"|'(?:\.\/)?tsconfig\.json'|(?:\.\/)?tsconfig\.json)$/.test(
    command,
  )
    ? ['build', 'tsconfig.json']
    : undefined;
}
function isCleanInvocation(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    !/[\r\n]/.test(value) &&
    /^[ \t]*(?:pnpm[ \t]+exec[ \t]+)?node[ \t]+(?:"(?:\.\/)?clean\.mjs"|'(?:\.\/)?clean\.mjs'|(?:\.\/)?clean\.mjs)[ \t]*$/.test(
      value,
    )
  );
}
export async function gradeOutputWorkflow(
  task: TaskSpec,
  fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const manifest = final.entries.find((entry) => entry.path === 'package.json');
  const scripts =
    manifest?.kind === 'file'
      ? JSON.parse(Buffer.from(manifest.content, 'base64').toString('utf8'))
          .scripts
      : {};
  const internalArguments = liminaArguments(scripts['check:types']);
  const outputArguments = liminaArguments(scripts.build);
  const assertions: AssertionReport['assertions'] = [
    {
      id: 'workflow-roles',
      passed:
        JSON.stringify(internalArguments) === '["checker","build"]' &&
        JSON.stringify(outputArguments) === '["build","tsconfig.json"]' &&
        isCleanInvocation(scripts.clean),
    },
  ];
  const commands: CommandEvidence[] = [];
  const run = async (arguments_: string[]) => {
    const result = await verifier.command('/usr/local/bin/node', arguments_);
    commands.push(result);
    return result;
  };
  async function checkOutputConsumption(): Promise<void> {
    const copied = await run([
      '-e',
      "const fs=require('fs');process.stdout.write(JSON.stringify(fs.readFileSync('dist/contracts.d.ts').equals(fs.readFileSync('src/contracts.d.ts'))));",
    ]);
    assertions.push({
      id: 'local-declaration-copied',
      passed: copied.exitCode === 0 && copied.stdout === 'true',
    });
    const runtime = await run([
      '--input-type=module',
      '-e',
      "import {twice} from './dist/index.js';process.stdout.write(JSON.stringify([twice({value:4}),twice({value:-3}),twice({value:1.25})]));",
    ]);
    assertions.push({
      id: 'runtime-consumption',
      passed: runtime.exitCode === 0 && runtime.stdout === '[8,-6,2.5]',
    });
    const consumer = await run([
      '-e',
      String.raw`const fs=require('fs');fs.mkdirSync('.eval-tmp',{recursive:true});fs.writeFileSync('.eval-tmp/consumer.ts',"import {twice} from '../dist/index.js';\nexport const value:number=twice({value:3});\n");fs.writeFileSync('.eval-tmp/tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,types:[]},files:['consumer.ts']}));`,
    ]);
    const types = await run([
      '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc',
      '-p',
      '.eval-tmp/tsconfig.json',
      '--pretty',
      'false',
    ]);
    assertions.push({
      id: 'type-consumption',
      passed: consumer.exitCode === 0 && types.exitCode === 0,
    });
    const injection = await run([
      '-e',
      String.raw`require('fs').writeFileSync('.eval-tmp/consumer.ts',"import {twice} from '../dist/index.js';\nexport const value:number=twice({value:'wrong'});\n")`,
    ]);
    const rejected = await run([
      '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc',
      '-p',
      '.eval-tmp/tsconfig.json',
      '--pretty',
      'false',
    ]);
    assertions.push({
      id: 'consumer-type-error',
      passed:
        injection.exitCode === 0 &&
        rejected.exitCode === 2 &&
        rejected.stdout.includes('error TS2322:') &&
        rejected.stdout.includes('.eval-tmp/consumer.ts'),
    });
    const secondClean = await run(['clean.mjs']);
    const rebuilt = outputArguments
      ? await run([cli, ...outputArguments])
      : undefined;
    const consumedAgain = await run([
      '--input-type=module',
      '-e',
      "import {twice} from './dist/index.js';process.stdout.write(String(twice({value:11})));",
    ]);
    assertions.push({
      id: 'clean-rebuild',
      passed:
        secondClean.exitCode === 0 &&
        rebuilt?.exitCode === 0 &&
        consumedAgain.exitCode === 0 &&
        consumedAgain.stdout === '22',
    });
  }
  const setup = await run([
    '-e',
    "require('fs').symlinkSync('/opt/limina-evals/runtime/node_modules','/workspace/node_modules')",
  ]);
  if (setup.exitCode === 0) {
    const clean = await run(['clean.mjs']);
    const expectedInputs = fixture.entries
      .filter(
        (entry) =>
          entry.kind === 'file' &&
          [
            'src/index.ts',
            'src/contracts.d.ts',
            'tsconfig.json',
            'limina.config.mjs',
            'clean.mjs',
          ].includes(entry.path),
      )
      .map((entry) => [entry.path, entry.kind === 'file' ? entry.sha256 : '']);
    const cleanState = await run([
      '-e',
      `const fs=require('fs'),crypto=require('crypto');const entries=${JSON.stringify(expectedInputs)};process.stdout.write(JSON.stringify({absent:!fs.existsSync('.limina')&&!fs.existsSync('dist'),preserved:entries.every(([file,hash])=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')===hash)}));`,
    ]);
    assertions.push({
      id: 'clean-preserves-inputs',
      passed:
        clean.exitCode === 0 &&
        cleanState.exitCode === 0 &&
        cleanState.stdout === '{"absent":true,"preserved":true}',
    });
    const internal = internalArguments
      ? await run([cli, ...internalArguments])
      : undefined;
    const internalState = await run([
      '-e',
      "const fs=require('fs');function declaration(root){return fs.existsSync(root)&&fs.readdirSync(root,{recursive:true}).some(file=>file.endsWith('.d.ts'));}process.stdout.write(JSON.stringify({internal:declaration('.limina/dts'),user:fs.existsSync('dist')}));",
    ]);
    assertions.push({
      id: 'internal-declarations-only',
      passed:
        internal?.exitCode === 0 &&
        internalState.exitCode === 0 &&
        internalState.stdout === '{"internal":true,"user":false}',
    });
    const output = outputArguments
      ? await run([cli, ...outputArguments])
      : undefined;
    assertions.push({ id: 'user-build', passed: output?.exitCode === 0 });
    const builtFiles = await run([
      '-e',
      "const fs=require('fs'),crypto=require('crypto');const files=[];function walk(root){for(const entry of fs.readdirSync(root,{withFileTypes:true})){const file=root+'/'+entry.name;if(entry.isDirectory())walk(file);else if(entry.isFile())files.push([file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);else throw Error('Unexpected output type');}}walk('dist');process.stdout.write(JSON.stringify(files.sort()));",
    ]);
    const submitted = final.entries
      .filter(
        (entry) => entry.kind === 'file' && entry.path.startsWith('dist/'),
      )
      .map((entry) => [entry.path, entry.kind === 'file' ? entry.sha256 : ''])
      .toSorted((left, right) =>
        Buffer.compare(Buffer.from(left[0]!), Buffer.from(right[0]!)),
      );
    let hasMatchingOutput: boolean;
    try {
      hasMatchingOutput =
        builtFiles.exitCode === 0 &&
        JSON.stringify(submitted) ===
          JSON.stringify(JSON.parse(builtFiles.stdout));
    } catch {
      hasMatchingOutput = false;
    }
    assertions.push({
      id: 'delivered-output-matches',
      passed: hasMatchingOutput,
    });
    await checkOutputConsumption();
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
