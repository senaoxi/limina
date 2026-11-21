import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { AnalysisObserver } from '../application/analysis/observability';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';
import { emitAnalysisProfile } from '../profiling/report';
import { analysisProfileJsonSchema } from '../profiling/report-schema';

const test = it.extend<{ workspace: { base: string; cwd: string } }>({
  workspace: async ({ task }, use) => {
    const prefix = path.join(tmpdir(), `limina-profile-report-${task.id}-`);
    const temporary = await mkdtemp(prefix);
    const base = await realpath(temporary);
    const cwd = path.join(base, 'workspace');
    try {
      await mkdir(cwd);
      await use({ base, cwd });
    } finally {
      vi.restoreAllMocks();
      await rm(base, { recursive: true, force: true });
    }
  },
});

function createProfile({ base, cwd }: { base: string; cwd: string }) {
  const observer = new AnalysisObserver('limina check', performance.now());
  observer.setRoot(cwd);
  const source = path.join(cwd, 'a space', '配置.json');
  const project = observer.project(source, { executionChecker: 'tsgo' });
  observer.project(path.join(base, 'fixture-private-location', 'other.json'));
  const create = observer.start('native-program-create', ['project', project]);
  observer.finish(create);
  observer.decision(
    'native-context',
    {
      stage: 'admission',
      outcome: 'rejected',
      causes: [{ code: 'input-changed' }],
    },
    observer.path(source),
    create,
  );
  observer.stop(true);
  return observer.snapshot();
}

function namespace(cwd: string) {
  return createLiminaArtifactNamespace({ generation: 0, rootDir: cwd });
}

test('writes a schema-backed allowlisted report and shows project, Program and cause on stderr', async ({
  workspace,
}) => {
  const { base, cwd } = workspace;
  const profile = createProfile(workspace);
  const withLegacyFields = {
    ...profile,
    runtime: {
      ...profile.runtime,
      executableRealPath: path.join(base, 'fixture-private-executable'),
    },
    trace: { command: 'fixture-private-argument' },
  };
  const outputDirectory = path.join(base, 'external');
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk, encoding, callback) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      done?.();
      return String(chunk).length > 0;
    });
  await emitAnalysisProfile({
    cwd,
    namespace: namespace(cwd),
    outputDirectory,
    profile: withLegacyFields,
    stderr: 'verbose',
  });

  const file = path.join(outputDirectory, `${profile.invocation.id}.json`);
  const content = await readFile(file, 'utf8');
  expect(content).not.toContain('fixture-private');
  expect(content).not.toContain('executableRealPath');
  expect(content).not.toContain('"trace"');
  const document: unknown = JSON.parse(content);
  expect(document).toMatchObject({
    schemaVersion: 2,
    projects: [
      { path: 'a space/配置.json' },
      { path: expect.stringMatching(/^external-\d+$/u) },
    ],
    decisions: [{ subject: 'a space/配置.json' }],
    summary: {
      projectRows: [
        expect.objectContaining({
          programs: [
            {
              op: 'native-program-create',
              attempts: 1,
              created: 1,
              failed: 0,
              pending: 0,
              passes: [],
            },
          ],
        }),
        expect.anything(),
      ],
    },
  });
  expect(stderr).toHaveBeenCalledWith(
    expect.stringContaining('a space/配置.json  tsgo'),
    expect.any(Function),
  );
  expect(stderr).toHaveBeenCalledWith(
    expect.stringContaining('1/1  input-changed'),
    expect.any(Function),
  );
  expect(stderr).toHaveBeenCalledWith(
    expect.stringContaining('Context work unions'),
    expect.any(Function),
  );
  if (process.platform !== 'win32')
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
  const schemaUrl = new URL(
    '../../schemas/analysis-profile-v2.schema.json',
    import.meta.url,
  );
  expect(JSON.parse(await readFile(schemaUrl, 'utf8'))).toEqual(
    analysisProfileJsonSchema(),
  );
});

test('expires only recognized default v2 reports and leaves explicitly routed reports intact', async ({
  workspace,
}) => {
  const { cwd } = workspace;
  const profiles = path.join(cwd, '.limina', 'profiles');
  const explicit = path.join(profiles, 'explicit');
  await mkdir(explicit, { recursive: true });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  async function oldJson(directory: string, schemaVersion: number) {
    const id = randomUUID();
    const file = path.join(directory, `${id}.json`);
    await writeFile(
      file,
      JSON.stringify({ schemaVersion, invocation: { id } }),
    );
    await utimes(file, old, old);
    return path.basename(file);
  }
  const retired = await oldJson(profiles, 2);
  const unrelated = await oldJson(profiles, 1);
  const archived = await oldJson(explicit, 2);
  const current = createProfile(workspace);
  await emitAnalysisProfile({
    cwd,
    namespace: namespace(cwd),
    outputDirectory: undefined,
    profile: current,
    stderr: 'silent',
  });
  const explicitProfile = createProfile(workspace);
  await emitAnalysisProfile({
    cwd,
    namespace: namespace(cwd),
    outputDirectory: explicit,
    profile: explicitProfile,
    stderr: 'silent',
  });

  expect(await readdir(profiles)).not.toContain(retired);
  expect(await readdir(profiles)).toContain(unrelated);
  expect(await readdir(profiles)).toContain(`${current.invocation.id}.json`);
  expect(await readdir(explicit)).toEqual(
    expect.arrayContaining([archived, `${explicitProfile.invocation.id}.json`]),
  );
});

test('rejects governed inputs and aliased destinations and preserves an existing invocation report', async ({
  workspace,
}) => {
  const { base, cwd } = workspace;
  const profile = createProfile(workspace);
  const knownNamespace = namespace(cwd);
  const outputDirectory = path.join(base, 'external');
  const options = {
    cwd,
    namespace: knownNamespace,
    outputDirectory,
    profile,
    stderr: 'silent',
  } as const;
  await emitAnalysisProfile(options);
  const file = path.join(outputDirectory, `${profile.invocation.id}.json`);
  const before = await readFile(file, 'utf8');
  await emitAnalysisProfile({
    ...options,
    profile: {
      ...profile,
      invocation: { ...profile.invocation, result: 'failed' },
    },
  });
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(await readdir(outputDirectory)).toEqual([path.basename(file)]);

  const withinCwd = path.join(cwd, 'reports');
  await emitAnalysisProfile({
    ...options,
    namespace: undefined,
    outputDirectory: withinCwd,
  });
  await expect(lstat(withinCwd)).rejects.toMatchObject({ code: 'ENOENT' });
  const alias = path.join(base, 'aliased-root');
  await symlink(cwd, alias, 'junction');
  await emitAnalysisProfile({
    ...options,
    outputDirectory: path.join(alias, 'reports'),
  });
  await expect(lstat(withinCwd)).rejects.toMatchObject({ code: 'ENOENT' });
});
