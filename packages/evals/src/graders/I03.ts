import type { AssertionReport } from '../core/outcome.ts';
import type { Snapshot } from '../core/snapshot.ts';
import type { TaskSpec } from '../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../runner/docker-verifier.ts';

export async function gradeManifestBoundary(
  task: TaskSpec,
  _fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const entry = final.entries.find((value) => value.path === 'diagnosis.json');
  let isDiagnosisCorrect = false;
  if (entry?.kind === 'file') {
    try {
      const diagnosis = JSON.parse(
        Buffer.from(entry.content, 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      isDiagnosisCorrect =
        diagnosis.status === 'blocked' &&
        diagnosis.target === 'nested/app' &&
        diagnosis.nearestManifest === 'nested/package.json' &&
        diagnosis.reason === 'invalid_manifest';
    } catch {
      isDiagnosisCorrect = false;
    }
  }
  // Fixed product code runs on protected fixture inputs; only observations leave the container.
  const command = await verifier.command('/usr/local/bin/node', [
    '--input-type=commonjs',
    '-e',
    String.raw`
const fs=require('fs');const {spawnSync}=require('child_process');
const before=fs.readFileSync('/workspace/package.json','utf8');
const result=spawnSync('/usr/local/bin/node',['/opt/limina-evals/runtime/node_modules/limina/bin/limina.js','init','--yes'],{cwd:'/workspace/nested/app',encoding:'utf8',timeout:60000});
const configs=['/workspace','/workspace/nested','/workspace/nested/app'].flatMap(root=>['mts','ts','mjs','js'].map(ext=>root+'/limina.config.'+ext));
process.stdout.write(JSON.stringify({exitCode:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.code??null,ancestorUnchanged:fs.readFileSync('/workspace/package.json','utf8')===before,noConfigs:configs.every(file=>!fs.existsSync(file)),invalidManifestPreserved:fs.readFileSync('/workspace/nested/package.json','utf8')==='[]\n'}));
`,
  ]);
  let isRejected = false;
  let isBoundaryPreserved = false;
  let hasCommandError = command.timedOut || command.exitCode !== 0;
  try {
    const observed = JSON.parse(command.stdout) as {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      error: string | null;
      ancestorUnchanged: boolean;
      noConfigs: boolean;
      invalidManifestPreserved: boolean;
    };
    hasCommandError ||= observed.error !== null || observed.exitCode === null;
    isRejected =
      observed.exitCode === 1 &&
      `${observed.stdout}\n${observed.stderr}`.includes(
        'Invalid package.json object',
      );
    isBoundaryPreserved =
      observed.ancestorUnchanged &&
      observed.noConfigs &&
      observed.invalidManifestPreserved;
  } catch {
    hasCommandError = true;
  }
  return {
    report: {
      taskId: task.id,
      graderDigest: task.gradingContract.graderDigest,
      status: hasCommandError ? 'error' : 'complete',
      assertions: [
        { id: 'nearest-manifest-diagnosed', passed: isDiagnosisCorrect },
        { id: 'init-rejects-invalid-manifest', passed: isRejected },
        { id: 'ancestor-not-initialized', passed: isBoundaryPreserved },
      ],
    },
    commands: [command],
  };
}
