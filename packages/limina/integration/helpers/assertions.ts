import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';

import {
  toPortablePath,
  toPortableRelativePath,
} from '../../src/__tests__/helpers/path';
import type { PreparedFixture } from './fixture';
import { runLimina, type RunLiminaResult } from './run-limina';

export async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }

    throw error;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

export function resolveGeneratedPath(
  configPath: string,
  value: string,
): string {
  return toPortablePath(path.resolve(path.dirname(configPath), value));
}

export function formatLiminaResult(result: RunLiminaResult): string {
  return [
    `fixture: ${result.fixtureName}`,
    `exit code: ${String(result.code)}`,
    `signal: ${String(result.signal)}`,
    `timed out: ${String(result.timedOut)}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
  ].join('\n');
}

export function expectLiminaSuccess(result: RunLiminaResult): void {
  const diagnostic = formatLiminaResult(result);

  expect(result.timedOut, diagnostic).toBe(false);
  expect(result.signal, diagnostic).toBeNull();
  expect(result.code, diagnostic).toBe(0);
}

export async function runFixtureLimina(
  fixture: PreparedFixture,
  args: string[],
): Promise<RunLiminaResult> {
  return runLimina({
    args: ['--config', fixture.configPath, ...args],
    cwd: fixture.cwd,
    fixtureName: fixture.fixtureName,
    timeout: 90_000,
  });
}

export function expectPathInside(rootDir: string, candidatePath: string): void {
  const relativePath = toPortableRelativePath(rootDir, candidatePath);

  expect(relativePath).not.toBe('..');
  expect(relativePath.startsWith('../')).toBe(false);
}
