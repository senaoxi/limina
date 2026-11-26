import type { AnalysisRead } from '#utils/analysis-input';
import { normalizeAbsolutePath } from '#utils/path';
import { realpathSync } from 'node:fs';
import ts from 'typescript';
import {
  AnalysisInputDriftError,
  type InputDependency,
  type InputKind,
} from './contracts';
import {
  directoryFingerprint,
  packageManifestState,
  pathBinding,
} from './directory-fingerprint';
import { EpochInputReplay, type EpochInputs } from './epoch-inputs';
import { analysisHash } from './identity';
import { inputStat, isRegularFile } from './input-state';
import type { NativeAnalysisCache } from './native-cache';
import { typePackageInventory } from './package-inputs';
import { physicalEntry } from './physical-entry';

function* contextDependencies(
  cache: NativeAnalysisCache,
  queryIds: Iterable<string>,
  environment: readonly InputDependency[],
): Iterable<InputDependency> {
  yield* environment;
  for (const id of queryIds) yield* cache.queries[id].dependencies;
}

export function bindResolutionExecutionInputs(
  scope: EpochInputs,
  cache: NativeAnalysisCache,
  queryIds: Iterable<string>,
  environment: readonly InputDependency[] = [],
): void {
  const replay = new EpochInputReplay();
  const seen = new Set<string>();
  for (const dependency of contextDependencies(cache, queryIds, environment)) {
    if (seen.has(dependency.inputId)) continue;
    seen.add(dependency.inputId);
    const { kind, path } = cache.inputs.records[dependency.inputId];
    const receipt = executionReceipt(
      kind,
      path,
      dependency.expectedVersion,
      cache,
    );
    if (receipt !== null)
      scope.bind(
        {
          key: JSON.stringify(['resolution-execution', kind, path]),
          path,
          ...receipt,
        },
        replay,
      );
  }
}

function executionReceipt(
  kind: InputKind,
  path: string,
  version: string,
  cache: NativeAnalysisCache,
): Pick<AnalysisRead, 'value' | 'read' | 'descriptor'> | null {
  switch (kind) {
    case 'config-mtime':
    case 'affecting-mtime': {
      return {
        value: cache.inputs.observedMtime(path),
        read: () => {
          const stat = inputStat(path);
          return isRegularFile(stat) ? stat.mtimeMs : undefined;
        },
      };
    }
    case 'file':
    case 'directory': {
      return {
        descriptor: { kind, path },
        value: version === analysisHash(true),
        read: () =>
          kind === 'file'
            ? (inputStat(path)?.isFile() ?? false)
            : (inputStat(path)?.isDirectory() ?? false),
      };
    }
    case 'directories': {
      const read = () => ts.sys.getDirectories(path);
      const value = read();
      if (analysisHash(value) !== version)
        throw new AnalysisInputDriftError(path);
      return { descriptor: { kind, path }, value, read };
    }
    case 'realpath': {
      return {
        value: version,
        read: () =>
          analysisHash(
            inputStat(path)
              ? normalizeAbsolutePath(realpathSync.native(path))
              : null,
          ),
      };
    }
    case 'manifest': {
      return {
        value: version,
        read: () => analysisHash(packageManifestState(path)),
      };
    }
    case 'directory-identity': {
      return {
        value: version,
        read: () => analysisHash([pathBinding(path), physicalEntry(path)]),
      };
    }
    case 'type-packages': {
      return {
        value: version,
        read: () => analysisHash(typePackageInventory(path)),
      };
    }
    case 'tree': {
      return { value: version, read: () => directoryFingerprint(path) };
    }
    case 'binding': {
      return { value: version, read: () => analysisHash(pathBinding(path)) };
    }
    default: {
      return null;
    }
  }
}
