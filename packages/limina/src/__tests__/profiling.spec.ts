import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { collectRuntimeTreeIdentity } from '../profiling/identity';
import { createProfilingMetricsRecorder } from '../profiling/metrics';

async function createRuntimeFixture(): Promise<{
  cleanup(): Promise<void>;
  executablePath: string;
  packageRoot: string;
  rootDir: string;
}> {
  const rootDir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'limina-profile-')),
  );
  const packageRoot = path.join(rootDir, 'runtime');
  const executablePath = path.join(packageRoot, 'bin', 'limina.js');
  await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await mkdir(path.join(packageRoot, 'chunks'), { recursive: true });
  await writeFile(executablePath, '#!/usr/bin/env node\n');
  await writeFile(path.join(packageRoot, 'cli.js'), 'export {};\n');
  await writeFile(path.join(packageRoot, 'chunks', 'dep.js'), 'export {};\n');
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ bin: { limina: './bin/limina.js' } }, null, 2)}\n`,
  );
  return {
    cleanup: () => rm(rootDir, { force: true, recursive: true }),
    executablePath,
    packageRoot,
    rootDir,
  };
}

describe('profiling identity', () => {
  it('hashes the complete runtime tree in stable relative-path order', async () => {
    const fixture = await createRuntimeFixture();

    try {
      const first = await collectRuntimeTreeIdentity({
        executableLogicalPath: fixture.executablePath,
        packageLogicalPath: fixture.packageRoot,
      });
      const second = await collectRuntimeTreeIdentity({
        executableLogicalPath: fixture.executablePath,
        packageLogicalPath: fixture.packageRoot,
      });

      expect(first).toEqual(second);
      expect(first.fileCount).toBe(4);
      expect(first.treeHash).toMatch(/^[a-f\d]{64}$/u);

      await writeFile(path.join(fixture.packageRoot, 'cli.js'), 'changed\n');
      const changed = await collectRuntimeTreeIdentity({
        executableLogicalPath: fixture.executablePath,
        packageLogicalPath: fixture.packageRoot,
      });
      expect(changed.treeHash).not.toBe(first.treeHash);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps Unicode runtime tree hashes independent of localeCompare', async () => {
    const fixture = await createRuntimeFixture();
    await writeFile(path.join(fixture.packageRoot, 'a.js'), 'a\n');
    await writeFile(path.join(fixture.packageRoot, 'z.js'), 'z\n');
    await writeFile(path.join(fixture.packageRoot, 'ä.js'), 'umlaut\n');
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => {
        throw new Error('runtime identity used localeCompare');
      });

    try {
      const identity = await collectRuntimeTreeIdentity({
        executableLogicalPath: fixture.executablePath,
        packageLogicalPath: fixture.packageRoot,
      });

      expect(identity.fileCount).toBe(7);
      expect(identity.treeHash).toMatch(/^[a-f\d]{64}$/u);
    } finally {
      localeCompare.mockRestore();
      await fixture.cleanup();
    }
  });

  it('rejects symlink entries inside the runtime tree', async () => {
    const fixture = await createRuntimeFixture();
    await symlink(
      path.join(fixture.packageRoot, 'cli.js'),
      path.join(fixture.packageRoot, 'linked.js'),
    );

    try {
      await expect(
        collectRuntimeTreeIdentity({
          executableLogicalPath: fixture.executablePath,
          packageLogicalPath: fixture.packageRoot,
        }),
      ).rejects.toThrow(/contains a symbolic link/u);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('profiling metrics', () => {
  it('orders persisted metric snapshots independently of localeCompare', () => {
    const metrics = createProfilingMetricsRecorder();
    metrics.record({ name: 'validator', provider: 'z' });
    metrics.record({ name: 'validator', provider: 'ä' });
    metrics.record({ name: 'validator', provider: 'a' });
    const localeCompare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => {
        throw new Error('profiling metrics used localeCompare');
      });

    try {
      expect(metrics.snapshot().map((metric) => metric.provider)).toEqual([
        'a',
        'z',
        'ä',
      ]);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('aggregates counters deterministically without retaining every event', () => {
    const metrics = createProfilingMetricsRecorder();
    metrics.record({
      count: 2,
      durationMs: 3,
      kind: 'batch',
      name: 'artifact-safety-lstat',
      provider: 'artifact-namespace',
    });
    metrics.record({
      durationMs: 5,
      kind: 'batch',
      name: 'artifact-safety-lstat',
      provider: 'artifact-namespace',
    });

    expect(metrics.snapshot()).toEqual([
      {
        count: 3,
        durationMs: 8,
        estimatedBytes: 0,
        kind: 'batch',
        name: 'artifact-safety-lstat',
        provider: 'artifact-namespace',
        reports: 2,
      },
    ]);
  });
});
