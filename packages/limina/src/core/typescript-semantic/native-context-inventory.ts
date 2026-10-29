import { normalizeAbsolutePath } from '#utils/path';
import ts from 'typescript';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import { effectiveCompilerOptions } from './compiler-options';
import type { FileDependencyFacts } from './file-dependency-facts';
import { nativeFingerprint } from './native-file-identity';
import { unqualifiedNativeLoads } from './native-load-qualification';
import type { NativeObservationAdapter } from './native-observation-adapter';
import {
  nativeCompilerApi,
  type NativeObservedProgram,
  nativeProgramSource,
} from './native-program-api';
import type { NativeRequestRecord } from './native-program-records';
import type { NativeModuleObservation } from './native-program-requests';

const liveInventories = new WeakSet<NativeContextInventory>();
export function isLiveNativeInventory(
  inventory: NativeContextInventory | undefined,
): boolean {
  return inventory !== undefined && liveInventories.has(inventory);
}
export interface NativeModulePremises {
  readonly requestId: string;
  readonly sourceFingerprint: string;
  readonly sourceLoadGap?: string;
  readonly role: 'import' | 'augmentation';
  readonly mode?: ts.ResolutionMode;
  readonly options?: ts.CompilerOptions;
  readonly sourceIsDeclaration: boolean;
  readonly sourceIsExternal: boolean;
  readonly excludedDocumentation: boolean;
  readonly ownAmbient: boolean;
}

export interface NativeContextInventory {
  readonly modules: readonly NativeModulePremises[];
  readonly members: readonly string[];
  readonly syntax: readonly {
    readonly file: string;
    readonly fingerprint: string;
  }[];
  readonly occurrences: readonly {
    readonly requestId: string;
    readonly fingerprint: string;
  }[];
  readonly loads: readonly {
    readonly requestId: string;
    readonly target: string;
    readonly source: string;
  }[];
  readonly roots: readonly {
    readonly root: string;
    readonly source: string;
  }[];
}

/** Capture while the actual Program/AST exists, never from restored projections.
 * Fingerprints retain exact UTF-16 ranges, kind, ordinal and synthetic metadata.
 * Load aliases preserve the SourceFile returned by the compiler for redirects.
 */
export function captureNativeContextInventory(
  adapter: NativeObservationAdapter,
  entries: readonly NativeRequestRecord[],
  syntax: ReadonlyMap<string, FileDependencyFacts>,
): NativeContextInventory {
  const resolutions = new Map<
    string,
    (typeof adapter.snapshot.resolutions)[number]
  >();
  for (const resolution of adapter.snapshot.resolutions)
    if (!resolutions.has(resolution.requestId))
      resolutions.set(resolution.requestId, resolution);
  const unqualified = unqualifiedNativeLoads(
    adapter.program as NativeObservedProgram,
    adapter.snapshot.requests.map((request) => ({
      request,
      resolution: resolutions.get(request.id)!,
    })),
  );
  const inventory = freezeNativeData({
    modules: adapter.modules.map((observation) => ({
      ...captureModulePremises(
        observation,
        adapter.program as NativeObservedProgram,
        ts,
      ),
      ...(unqualified.has(observation.source.fileName) && {
        sourceLoadGap: 'path-fallback-source-classification-unavailable',
      }),
    })),
    members: adapter.program
      .getSourceFiles()
      .map((source) => normalizeAbsolutePath(source.fileName)),
    syntax: [...syntax].map(([file, facts]) => ({
      file,
      fingerprint: nativeFingerprint(facts),
    })),
    occurrences: entries.map(({ request, record }) => ({
      requestId: request.id,
      fingerprint: nativeFingerprint([request, record]),
    })),
    loads: loadedSources(adapter),
    roots: [...new Set(adapter.program.getRootFileNames())].flatMap((root) => {
      const source = adapter.program.getSourceFile(root);
      return source === undefined
        ? []
        : [{ root, source: normalizeAbsolutePath(source.fileName) }];
    }),
  });
  liveInventories.add(inventory);
  return inventory;
}

function loadedSources(adapter: NativeObservationAdapter) {
  return adapter.snapshot.resolutions
    .filter(
      (resolution) =>
        resolution.compilerLoad === 'loaded' && resolution.target !== null,
    )
    .flatMap((resolution) => {
      const target = resolution.target!.lexicalPath;
      const source = adapter.program.getSourceFile(target);
      return source === undefined
        ? []
        : [
            {
              requestId: resolution.requestId,
              target,
              source: normalizeAbsolutePath(source.fileName),
            },
          ];
    });
}

export function captureModulePremises(
  observation: NativeModuleObservation,
  program: NativeObservedProgram,
  compiler: typeof ts,
): NativeModulePremises {
  const options = program.getCompilerOptionsForFile(observation.source);
  return {
    requestId: observation.requestId,
    sourceFingerprint: nativeFingerprint(observation.source.text),
    role: observation.role,
    ...(observation.mode !== undefined && { mode: observation.mode }),
    ...(options !== undefined && {
      options: effectiveCompilerOptions(options),
    }),
    sourceIsDeclaration: observation.source.isDeclarationFile,
    sourceIsExternal: program.isSourceFileFromExternalLibrary(
      observation.source,
    ),
    excludedDocumentation:
      (observation.literal.flags & 16_777_216) !== 0 &&
      !nativeCompilerApi(compiler).isInJSFile(observation.literal),
    ownAmbient: nativeProgramSource(
      observation.source,
    ).ambientModuleNames.includes(observation.literal.text),
  };
}
