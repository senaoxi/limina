import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';
import { describe, expect, it, vi } from 'vitest';
import { LiminaStructuredError } from '../check-reporting/errors';
import {
  mergeStandaloneFailureIssues,
  readStandaloneIssueInvocation,
  writeStandaloneFailureInvocation,
} from '../check-reporting/invocation-snapshot';
import { createLiminaCheckIssue } from '../check-reporting/structured';
import { createLiminaArtifactNamespace } from '../domain/artifacts/namespace';

function createIssue(rootDirectory: string, title: string, id?: string) {
  return createLiminaCheckIssue({
    code: 'LIMINA_CHECKER_BUILD_FAILED',
    filePath: path.join(rootDirectory, `${title}.json`),
    id,
    reason: `${title} failed`,
    rootDir: rootDirectory,
    task: 'checker:build',
    title,
  });
}

describe('standalone issue invocation snapshots', () => {
  it('merges caller and structured-error issues by ID with caller precedence', () => {
    const rootDirectory = path.resolve('invocation workspace');
    const callerIssue = createIssue(rootDirectory, 'caller', 'shared-id');
    const duplicateStructuredIssue = createIssue(
      rootDirectory,
      'structured duplicate',
      'shared-id',
    );
    const structuredIssue = createIssue(
      rootDirectory,
      'structured',
      'structured-id',
    );

    expect(
      mergeStandaloneFailureIssues({
        error: new LiminaStructuredError('failed', [
          duplicateStructuredIssue,
          structuredIssue,
        ]),
        issues: [callerIssue],
      }),
    ).toEqual([callerIssue, structuredIssue]);
  });

  it('creates a fallback only when both issue sources are empty', async () => {
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'limina-invocation-'),
    );
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: rootDirectory,
    });
    const structuredIssue = createIssue(rootDirectory, 'structured');
    const createFallbackIssue = vi.fn(() =>
      createIssue(rootDirectory, 'fallback'),
    );

    try {
      const invocation = await writeStandaloneFailureInvocation({
        artifactNamespace: namespace,
        command: 'limina checker build',
        createFallbackIssue,
        error: new LiminaStructuredError('failed', [structuredIssue]),
        issues: [],
        rootDir: rootDirectory,
      });

      expect(createFallbackIssue).not.toHaveBeenCalled();
      expect(invocation.issues).toEqual([structuredIssue]);

      const fallbackInvocation = await writeStandaloneFailureInvocation({
        artifactNamespace: namespace,
        command: 'limina checker build',
        createFallbackIssue,
        issues: [],
        rootDir: rootDirectory,
      });

      expect(createFallbackIssue).toHaveBeenCalledTimes(1);
      expect(fallbackInvocation.issues).toEqual([
        expect.objectContaining({ title: 'fallback' }),
      ]);
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it('keeps concurrent invocation records independently addressable', async () => {
    const rootDirectory = await mkdtemp(
      path.join(tmpdir(), 'limina-invocation-'),
    );
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir: rootDirectory,
    });
    const issues = [
      createIssue(rootDirectory, 'first'),
      createIssue(rootDirectory, 'second'),
    ];

    try {
      const invocations = await Promise.all(
        issues.map((issue) =>
          writeStandaloneFailureInvocation({
            artifactNamespace: namespace,
            command: 'limina checker build',
            createFallbackIssue: () => createIssue(rootDirectory, 'fallback'),
            issues: [issue],
            rootDir: rootDirectory,
          }),
        ),
      );

      expect(invocations[0]?.invocationId).not.toBe(
        invocations[1]?.invocationId,
      );
      await expect(
        readStandaloneIssueInvocation(
          rootDirectory,
          invocations[0]!.invocationId,
        ),
      ).resolves.toMatchObject({ issues: [{ id: issues[0]!.id }] });
      await expect(
        readStandaloneIssueInvocation(
          rootDirectory,
          invocations[1]!.invocationId,
        ),
      ).resolves.toMatchObject({ issues: [{ id: issues[1]!.id }] });
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });
});
