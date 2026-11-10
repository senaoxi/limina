import path from 'node:path';
import type { AssertionReport } from '../../core/outcome.ts';
import type { Snapshot } from '../../core/snapshot.ts';
import type { TaskSpec } from '../../core/task.ts';
import type {
  CommandEvidence,
  DockerVerifier,
} from '../../runner/docker-verifier.ts';

function relativePath(value: unknown): string | null {
  return typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    /^[a-z]:/i.test(value) ||
    path.posix.isAbsolute(value) ||
    value.split('/').includes('..')
    ? null
    : path.posix.normalize(value);
}

function readDiagnosis(final: Snapshot): Record<string, unknown> {
  const entry = final.entries.find((value) => value.path === 'diagnosis.json');
  if (entry?.kind !== 'file') return {};
  try {
    const value: unknown = JSON.parse(
      Buffer.from(entry.content, 'base64').toString('utf8'),
    );
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function gradeInitializationBoundary(
  task: TaskSpec,
  _fixture: Snapshot,
  final: Snapshot,
  verifier: DockerVerifier,
): Promise<{ report: AssertionReport; commands: CommandEvidence[] }> {
  const diagnosis = readDiagnosis(final);
  const requestedDirectory = relativePath(diagnosis.requestedDirectory);
  const command = await verifier.command('/usr/local/bin/node', [
    '--input-type=commonjs',
    '-e',
    `
const fs=require('fs'),crypto=require('crypto'),childProcess=require('child_process');
function snapshot(){const entries=[];function visit(relative){if(['node_modules','.agents','.eval-tmp'].includes(relative))return;const file='/workspace'+(relative?'/'+relative:'');const state=fs.lstatSync(file);if(state.isDirectory()){if(relative)entries.push({path:relative,kind:'directory',mode:state.mode&4095});for(const name of fs.readdirSync(file).sort())visit(relative?relative+'/'+name:name)}else if(state.isFile())entries.push({path:relative,kind:'file',mode:state.mode&4095,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});else entries.push({path:relative,kind:'link',target:fs.readlinkSync(file)})}visit('');return JSON.stringify(entries)}
const before=snapshot();
const result=childProcess.spawnSync('/usr/local/bin/node',['/opt/limina-evals/runtime/node_modules/limina/bin/limina.js','init','--yes'],{cwd:'/workspace/nested/app',encoding:'utf8',timeout:60000});
process.stdout.write(JSON.stringify({exitCode:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.code??null,workspaceUnchanged:snapshot()===before}));
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
      workspaceUnchanged: boolean;
    };
    hasCommandError ||=
      observed.error !== null ||
      !Number.isSafeInteger(observed.exitCode) ||
      typeof observed.workspaceUnchanged !== 'boolean';
    isRejected =
      observed.exitCode === 1 &&
      `${observed.stdout}\n${observed.stderr}`.includes(
        'Invalid package.json object',
      );
    isBoundaryPreserved = observed.workspaceUnchanged;
  } catch {
    hasCommandError = true;
  }
  return {
    report: {
      taskId: task.id,
      graderDigest: task.gradingContract.graderDigest,
      status: hasCommandError ? 'error' : 'complete',
      assertions: [
        {
          id: 'requested-directory-correct',
          passed:
            requestedDirectory !== null &&
            path.posix.resolve('/workspace', requestedDirectory) ===
              '/workspace/nested/app',
        },
        {
          id: 'manifest-boundary-diagnosed',
          passed:
            diagnosis.status === 'blocked' &&
            relativePath(diagnosis.nearestManifest) === 'nested/package.json' &&
            diagnosis.reason === 'invalid_manifest',
        },
        {
          id: 'governance-root-correct',
          passed: diagnosis.governanceRoot === null,
        },
        { id: 'init-rejects-invalid-manifest', passed: isRejected },
        { id: 'ancestor-not-initialized', passed: isBoundaryPreserved },
      ],
    },
    commands: [command],
  };
}
