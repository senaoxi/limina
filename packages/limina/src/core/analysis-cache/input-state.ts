import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import {
  type Dirent,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  type AnalysisCacheMetrics,
  type AnalysisInput,
  AnalysisInputDriftError,
  type InputKind,
} from './contracts';
import { analysisHash } from './identity';

function isMissing(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    String((error as NodeJS.ErrnoException).code),
  );
}

export function inputStat(filePath: string): Stats | undefined {
  try {
    return statSync(filePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function readStructural(filePath: string, kind: InputKind): unknown {
  const stat = inputStat(filePath);
  return stat === undefined
    ? !['file', 'directory'].includes(kind) && null
    : structuralReaders[kind]!(filePath, stat);
}

const structuralReaders: Partial<
  Record<InputKind, (file: string, stat: Stats) => unknown>
> = {
  file: (_file, stat) => stat.isFile(),
  directory: (_file, stat) => stat.isDirectory(),
  entries: (file, stat) => (stat.isDirectory() ? readEntries(file) : null),
  realpath: (file) => normalizeAbsolutePath(realpathSync.native(file)),
};

export function readInput(options: {
  kind: InputKind;
  path: string;
  previous?: AnalysisInput;
  metrics: AnalysisCacheMetrics;
}): AnalysisInput {
  const start = performance.now();
  options.metrics.probes += 1;
  const result =
    options.kind === 'content'
      ? readContent(options)
      : {
          path: options.path,
          kind: options.kind,
          version: analysisHash(readStructural(options.path, options.kind)),
        };
  options.metrics.probeMs += performance.now() - start;
  return result;
}

function readContent(options: Parameters<typeof readInput>[0]): AnalysisInput {
  const stat = inputStat(options.path);
  if (!isRegularFile(stat))
    return { path: options.path, kind: 'content', version: analysisHash(null) };
  return canTrustTimestamp(options.previous, stat.mtimeMs)
    ? { ...options.previous!, observedMtime: stat.mtimeMs }
    : readText(options, stat.mtimeMs);
}

export function isRegularFile(stat: Stats | undefined): stat is Stats {
  return stat !== undefined && stat.isFile();
}

function readText(
  options: Parameters<typeof readInput>[0],
  mtime: number,
): AnalysisInput {
  const checkedAt = Date.now();
  const start = performance.now();
  const text = readFileSync(options.path, 'utf8');
  options.metrics.reads += 1;
  options.metrics.readMs += performance.now() - start;
  const result = observedContent({
    path: options.path,
    text,
    checkedAt,
    beforeMtime: mtime,
    metrics: options.metrics,
  });
  if (result.verifiedThrough === undefined)
    throw new AnalysisInputDriftError(options.path);
  return result;
}

function canTrustTimestamp(
  previous: AnalysisInput | undefined,
  mtime: number,
): boolean {
  if (previous?.observedMtime === undefined) return false;
  const checkpoint = timestampCheckpoint(previous);
  return mtime <= checkpoint;
}

export function observedContent(options: {
  path: string;
  text: string;
  checkedAt: number;
  beforeMtime: number;
  metrics: AnalysisCacheMetrics;
}): AnalysisInput {
  const start = performance.now();
  const version = analysisHash(options.text);
  options.metrics.hashes += 1;
  options.metrics.hashMs += performance.now() - start;
  const after = inputStat(options.path);
  const observedMtime = after?.mtimeMs;
  const isStable = observedMtime === options.beforeMtime;
  return {
    path: options.path,
    kind: 'content',
    version,
    observedMtime,
    verifiedThrough: isStable
      ? Math.min(options.checkedAt, observedMtime!)
      : undefined,
    // Only manifests need old contents for the two-field change contract.
    text: manifestText(options),
  };
}

function manifestText(options: {
  path: string;
  text: string;
}): string | undefined {
  return options.path.endsWith('/package.json') ? options.text : undefined;
}

function timestampCheckpoint(previous: AnalysisInput): number {
  return Math.max(previous.observedMtime ?? 0, previous.verifiedThrough ?? 0);
}

function entryVersion(entry: Dirent): unknown {
  return [
    entry.name,
    entry.isFile(),
    entry.isDirectory(),
    entry.isSymbolicLink(),
  ];
}

function readEntries(file: string): unknown {
  return readdirSync(file, { withFileTypes: true })
    .sort((a, b) => compareCodeUnits(a.name, b.name))
    .map(entryVersion);
}
