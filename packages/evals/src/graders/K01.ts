import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

const cli = '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js';
export async function gradeCheckerRouting(
  task: TaskSpec,
  _fixture: Snapshot,
  final: Snapshot,
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
    "const fs=require('fs');if(fs.realpathSync('/workspace/node_modules')!=='/workspace/node_modules')throw Error('A protected project dependency volume is required');process.stdout.write(require('/workspace/node_modules/vue-tsc/package.json').version)",
  ]);
  if (setup.exitCode === 0) {
    const policy = await run([
      '--input-type=module',
      '-e',
      "import config from './limina.config.mjs';process.stdout.write(JSON.stringify(config.scope.source))",
    ]);
    assertions.push({
      id: 'source-policy-preserved',
      passed:
        policy.exitCode === 0 &&
        policy.stdout ===
          JSON.stringify({
            include: ['node/**/*.ts', 'ui/**/*.ts', 'ui/**/*.vue'],
          }),
    });
    const graph = await run([cli, 'graph', 'check']);
    assertions.push({ id: 'graph-valid', passed: graph.exitCode === 0 });
    const proof = await run([cli, 'proof', 'check']);
    assertions.push({ id: 'proof-valid', passed: proof.exitCode === 0 });
    const checked = await run([cli, 'checker', 'build']);
    assertions.push({
      id: 'both-checkers-pass',
      passed: checked.exitCode === 0,
    });
    const ownership = await run([
      '-e',
      "const m=JSON.parse(require('fs').readFileSync('.limina/manifest.json','utf8'));process.stdout.write(JSON.stringify([m.checkers.tsc?.roots?.sort()??[],m.checkers['vue-tsc']?.roots?.sort()??[]]))",
    ]);
    assertions.push({
      id: 'checker-ownership',
      passed:
        ownership.exitCode === 0 &&
        ownership.stdout ===
          JSON.stringify([['node/tsconfig.json'], ['ui/tsconfig.json']]),
    });
    for (const [file, text, code, assertion] of [
      [
        'node/version.ts',
        'export const version: number = "not a number";\n',
        'TS2322',
        'typescript-error-detected',
      ],
      [
        'ui/App.vue',
        '<script setup lang="ts">const title: string = "Hello";</script>\n<template><h1>{{ title.nonexistentEvalMethod() }}</h1></template>\n',
        'TS2339',
        'vue-template-error-detected',
      ],
    ] as const) {
      const injected = await run([
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(file)},${JSON.stringify(text)})`,
      ]);
      const rejected = await run([cli, 'checker', 'build']);
      const output = `${rejected.stdout}\n${rejected.stderr}`;
      assertions.push({
        id: assertion,
        passed:
          injected.exitCode === 0 &&
          rejected.exitCode === 1 &&
          output.includes(file) &&
          output.includes(`error ${code}:`),
      });
      if (file === 'ui/App.vue') {
        const plain = await run([
          '/opt/limina-evals/runtime/node_modules/typescript/bin/tsc',
          '-p',
          'ui/tsconfig.json',
          '--pretty',
          'false',
        ]);
        assertions.push({
          id: 'plain-tsc-misses-template-error',
          passed: plain.exitCode === 0,
        });
      }
      const original = final.entries.find((entry) => entry.path === file);
      if (original?.kind !== 'file')
        throw new Error('Protected checker source is missing');
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
