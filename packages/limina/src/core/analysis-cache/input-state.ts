import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';
import {
  type Dirent,
  readdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import {
  type AnalysisCacheMetrics,
  type AnalysisInput,
  AnalysisInputDriftError,
  type InputKind,
} from './contracts';
import { directoryObservation, pathBinding } from './directory-fingerprint';
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
  if (kind === 'binding') return pathBinding(filePath);
  const stat = inputStat(filePath);
  return stat === undefined
    ? missingStructural(kind)
    : structuralReaders[kind]!(filePath, stat);
}

function missingStructural(kind: InputKind): unknown {
  return kind === 'directories'
    ? []
    : !['file', 'directory'].includes(kind) && null;
}

const structuralReaders: Partial<
  Record<InputKind, (file: string, stat: Stats) => unknown>
> = {
  file: (_file, stat) => stat.isFile(),
  directory: (_file, stat) => stat.isDirectory(),
  directories: (file, stat) =>
    stat.isDirectory() ? ts.sys.getDirectories(file) : [],
  entries: (file, stat) => (stat.isDirectory() ? readEntries(file) : null),
  realpath: (file) => normalizeAbsolutePath(realpathSync.native(file)),
};

interface InputReadOptions {
  kind: InputKind;
  path: string;
  previous?: AnalysisInput;
  metrics: AnalysisCacheMetrics;
}
function readTree(options: InputReadOptions): AnalysisInput {
  const scan = directoryObservation(options.path);
  options.metrics.localRootScans = (options.metrics.localRootScans ?? 0) + 1;
  return { path: options.path, kind: options.kind, ...scan };
}
function readVersioned(options: InputReadOptions): AnalysisInput {
  return {
    path: options.path,
    kind: options.kind,
    version: analysisHash(readStructural(options.path, options.kind)),
  };
}
export function readInput(options: InputReadOptions): AnalysisInput {
  const start = performance.now();
  options.metrics.probes += 1;
  const readers: Partial<
    Record<InputKind, (options: InputReadOptions) => AnalysisInput>
  > = { tree: readTree, content: readContent, bytes: readContent };
  const result = (readers[options.kind] ?? readVersioned)(options);
  options.metrics.probeMs += performance.now() - start;
  return result;
}

function readContent(options: Parameters<typeof readInput>[0]): AnalysisInput {
  const stat = inputStat(options.path);
  if (!isRegularFile(stat))
    return {
      path: options.path,
      kind: options.kind,
      version: analysisHash(null),
    };
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
  if (options.kind === 'bytes') return readBytes(options, mtime);
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

function readBytes(
  options: Parameters<typeof readInput>[0],
  mtime: number,
): AnalysisInput {
  const start = performance.now();
  const bytes = readFileSync(options.path);
  options.metrics.reads += 1;
  options.metrics.readMs += performance.now() - start;
  const version = createHash('sha256').update(bytes).digest('hex');
  options.metrics.hashes += 1;
  if (inputStat(options.path)?.mtimeMs !== mtime)
    throw new AnalysisInputDriftError(options.path);
  return {
    path: options.path,
    kind: 'bytes',
    version,
    observedMtime: mtime,
    verifiedThrough: Math.min(Date.now(), mtime),
  };
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
