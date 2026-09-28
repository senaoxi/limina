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

function createIssue(rootDir: string, title: string, id?: string) {
  return createLiminaCheckIssue({
    code: 'LIMINA_CHECKER_BUILD_FAILED',
    filePath: path.join(rootDir, `${title}.json`),
    id,
    reason: `${title} failed`,
    rootDir,
    task: 'checker:build',
    title,
  });
}

describe('standalone issue invocation snapshots', () => {
  it('merges caller and structured-error issues by ID with caller precedence', () => {
    const rootDir = path.resolve('invocation workspace');
    const callerIssue = createIssue(rootDir, 'caller', 'shared-id');
    const duplicateStructuredIssue = createIssue(
      rootDir,
      'structured duplicate',
      'shared-id',
    );
    const structuredIssue = createIssue(rootDir, 'structured', 'structured-id');

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
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-invocation-'));
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir,
    });
    const structuredIssue = createIssue(rootDir, 'structured');
    const createFallbackIssue = vi.fn(() => createIssue(rootDir, 'fallback'));

    try {
      const invocation = await writeStandaloneFailureInvocation({
        artifactNamespace: namespace,
        command: 'limina checker build',
        createFallbackIssue,
        error: new LiminaStructuredError('failed', [structuredIssue]),
        issues: [],
        rootDir,
      });

      expect(createFallbackIssue).not.toHaveBeenCalled();
      expect(invocation.issues).toEqual([structuredIssue]);

      const fallbackInvocation = await writeStandaloneFailureInvocation({
        artifactNamespace: namespace,
        command: 'limina checker build',
        createFallbackIssue,
        issues: [],
        rootDir,
      });

      expect(createFallbackIssue).toHaveBeenCalledTimes(1);
      expect(fallbackInvocation.issues).toEqual([
        expect.objectContaining({ title: 'fallback' }),
      ]);
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps concurrent invocation records independently addressable', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'limina-invocation-'));
    const namespace = createLiminaArtifactNamespace({
      generation: 0,
      rootDir,
    });
    const issues = [
      createIssue(rootDir, 'first'),
      createIssue(rootDir, 'second'),
    ];

    try {
      const invocations = await Promise.all(
        issues.map((issue) =>
          writeStandaloneFailureInvocation({
            artifactNamespace: namespace,
            command: 'limina checker build',
            createFallbackIssue: () => createIssue(rootDir, 'fallback'),
            issues: [issue],
            rootDir,
          }),
        ),
      );

      expect(invocations[0]?.invocationId).not.toBe(
        invocations[1]?.invocationId,
      );
      await expect(
        readStandaloneIssueInvocation(rootDir, invocations[0]!.invocationId),
      ).resolves.toMatchObject({ issues: [{ id: issues[0]!.id }] });
      await expect(
        readStandaloneIssueInvocation(rootDir, invocations[1]!.invocationId),
      ).resolves.toMatchObject({ issues: [{ id: issues[1]!.id }] });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});
