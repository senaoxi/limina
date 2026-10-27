import { normalizeAbsolutePath } from '#utils/path';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import type { FileDependencyFacts } from './file-dependency-facts';
import { nativeFingerprint } from './native-file-identity';
import type { NativeObservationAdapter } from './native-observation-adapter';
import type { NativeRequestRecord } from './native-program-records';

export interface NativeContextInventory {
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
  return freezeNativeData({
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
