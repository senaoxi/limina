import type { ResolvedLiminaConfig } from '#config/runner';
import { readJsonConfig } from '#core/tsconfig/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import {
  isReadableTsconfigCandidate,
  type ReadableWorkspaceTsconfigCandidate,
  type WorkspaceTsconfigOutputRootRead,
} from '../types';

type NormalizedOutDirectory =
  | { kind: 'invalid'; reason: string }
  | { kind: 'value'; value: string };

function resolveDefaultOutputRoot(configPath: string): string {
  return normalizeAbsolutePath(
    path.resolve(path.dirname(configPath), './dist'),
  );
}

function normalizeStringOutDirectory(
  outDirectory: string,
): NormalizedOutDirectory {
  const value = outDirectory.trim();
  if (value.length === 0) {
    return {
      kind: 'invalid',
      reason: 'liminaOptions.outputs.outDir must be a non-empty relative path.',
    };
  }
  if (path.isAbsolute(value)) {
    return {
      kind: 'invalid',
      reason:
        'liminaOptions.outputs.outDir must be relative to its source config.',
    };
  }
  return { kind: 'value', value };
}

function normalizeOutDirectory(outDirectory: unknown): NormalizedOutDirectory {
  if (typeof outDirectory === 'string')
    return normalizeStringOutDirectory(outDirectory);
  return {
    kind: 'invalid',
    reason: 'liminaOptions.outputs.outDir must be a non-empty relative path.',
  };
}

function resolveExplicitOutputRoot(options: {
  configPath: string;
  outDir: unknown;
}): WorkspaceTsconfigOutputRootRead {
  const normalized = normalizeOutDirectory(options.outDir);
  if (normalized.kind === 'invalid') return normalized;
  return {
    kind: 'output',
    outputRoot: normalizeAbsolutePath(
      path.resolve(path.dirname(options.configPath), normalized.value),
    ),
  };
}

function tryReadConfig(
  config: ResolvedLiminaConfig,
  configPath: string,
): Record<string, unknown> | null {
  try {
    return readJsonConfig(config, configPath);
  } catch {
    return null;
  }
}

function readOutputsRecord(
  configObject: Record<string, unknown>,
): Record<string, unknown> | null {
  const liminaOptions = configObject.liminaOptions;
  return !isPlainRecord(liminaOptions) || !isPlainRecord(liminaOptions.outputs)
    ? null
    : liminaOptions.outputs;
}

function readCandidateOutputs(options: {
  candidate: ReadableWorkspaceTsconfigCandidate;
  config: ResolvedLiminaConfig;
}): Record<string, unknown> | null {
  const configObject = tryReadConfig(options.config, options.candidate.path);
  return configObject === null ? null : readOutputsRecord(configObject);
}

function resolveOutputsRecord(
  configPath: string,
  outputs: Record<string, unknown>,
): WorkspaceTsconfigOutputRootRead {
  if (outputs.outDir !== undefined) {
    return resolveExplicitOutputRoot({
      configPath,
      outDir: outputs.outDir,
    });
  }
  return {
    kind: 'output',
    outputRoot: resolveDefaultOutputRoot(configPath),
  };
}

export function readWorkspaceTsconfigOutputRoot(
  config: ResolvedLiminaConfig,
  candidate: ReadableWorkspaceTsconfigCandidate,
): WorkspaceTsconfigOutputRootRead {
  if (!isReadableTsconfigCandidate(candidate)) {
    throw new Error('Untrusted workspace tsconfig candidate.');
  }
  const outputs = readCandidateOutputs({ candidate, config });
  return outputs === null
    ? { kind: 'absent' }
    : resolveOutputsRecord(candidate.path, outputs);
}
