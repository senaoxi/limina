import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import type ts from 'typescript';
import type { VueConfigClosureEntry } from './vue-semantic-types';

export interface VueConfigReadRecorder {
  entries: Map<string, VueConfigClosureEntry>;
  record(fileName: string, content: string): void;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeVueVirtualFiles(
  virtualFiles: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> {
  return new Map(
    [...(virtualFiles?.entries() ?? [])]
      .map(
        ([fileName, content]) =>
          [normalizeAbsolutePath(fileName), content] as const,
      )
      .sort(([left], [right]) => compareCodeUnits(left, right)),
  );
}

function assertCompatibleOverlay(
  existing: string | undefined,
  incoming: string,
  fileName: string,
): void {
  if (existing === undefined) return;
  if (existing === incoming) return;
  throw new Error(
    `Conflicting Vue semantic virtual file overlays for ${fileName}.`,
  );
}

export function mergeVueVirtualFiles(
  base: ReadonlyMap<string, string>,
  incoming: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> {
  const merged = new Map(base);
  for (const [fileName, content] of normalizeVueVirtualFiles(incoming)) {
    assertCompatibleOverlay(merged.get(fileName), content, fileName);
    merged.set(fileName, content);
  }
  return normalizeVueVirtualFiles(merged);
}

export function createVueOverlayFingerprint(
  virtualFiles: ReadonlyMap<string, string>,
): string {
  return hashText(JSON.stringify([...virtualFiles.entries()]));
}

export function createVueConfigReadRecorder(): VueConfigReadRecorder {
  const entries = new Map<string, VueConfigClosureEntry>();
  return {
    entries,
    record(fileName, content) {
      const normalized = normalizeAbsolutePath(fileName);
      entries.set(normalized, {
        contentHash: hashText(content),
        filePath: normalized,
      });
    },
  };
}

function readOverlayOrDisk(options: {
  base: typeof ts.sys;
  encoding: string | undefined;
  fileName: string;
  normalized: string;
  virtualFiles: ReadonlyMap<string, string>;
}): string | undefined {
  const overlay = options.virtualFiles.get(options.normalized);
  if (overlay !== undefined) return overlay;
  return options.base.readFile(options.fileName, options.encoding);
}

function recordRead(options: {
  content: string | undefined;
  fileName: string;
  recorder: VueConfigReadRecorder | undefined;
}): void {
  if (options.content === undefined) return;
  options.recorder?.record(options.fileName, options.content);
}

export function createVueOverlaySystem(options: {
  recorder?: VueConfigReadRecorder;
  tsModule: typeof ts;
  virtualFiles: ReadonlyMap<string, string>;
}): typeof ts.sys {
  const base = options.tsModule.sys;
  return {
    ...base,
    fileExists(fileName): boolean {
      const normalized = normalizeAbsolutePath(fileName);
      return options.virtualFiles.has(normalized) || base.fileExists(fileName);
    },
    getModifiedTime(fileName): Date | undefined {
      if (options.virtualFiles.has(normalizeAbsolutePath(fileName))) {
        return new Date(0);
      }
      return base.getModifiedTime?.(fileName);
    },
    readFile(fileName, encoding): string | undefined {
      const normalized = normalizeAbsolutePath(fileName);
      const content = readOverlayOrDisk({
        base,
        encoding,
        fileName,
        normalized,
        virtualFiles: options.virtualFiles,
      });
      recordRead({ content, fileName: normalized, recorder: options.recorder });
      return content;
    },
  };
}
