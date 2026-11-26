import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { typeScriptBomText } from '#utils/typescript-bom';
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
import {
  directoryObservation,
  packageManifestState,
  pathBinding,
} from './directory-fingerprint';
import { analysisHash } from './identity';
import { typePackageInventory } from './package-inputs';
import { physicalEntry } from './physical-entry';

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
  if (kind === 'manifest') return packageManifestState(filePath);
  if (kind === 'type-packages') return typePackageInventory(filePath);
  if (kind === 'directory-identity')
    return [pathBinding(filePath), physicalEntry(filePath)];
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
  baseline?: { baselineTime: number; generation: string };
  captureTextVersions?: boolean;
  observeMtime?(path: string, mtime: number | undefined): void;
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
  > = {
    tree: readTree,
    content: readContent,
    bytes: readContent,
    'config-mtime': readModifiedTime,
    'affecting-mtime': readModifiedTime,
  };
  const result = (readers[options.kind] ?? readVersioned)(options);
  options.metrics.probeMs += performance.now() - start;
  return result;
}

function observedMtime(options: InputReadOptions): number | undefined {
  const stat = inputStat(options.path);
  const mtime = isRegularFile(stat) ? stat.mtimeMs : undefined;
  options.observeMtime?.(options.path, mtime);
  return mtime;
}

const absentVersion = analysisHash(null);

function canReusePublishedInput(
  options: InputReadOptions,
  mtime: number,
): boolean {
  return (
    options.previous !== undefined &&
    options.previous.version !== absentVersion &&
    options.baseline !== undefined &&
    mtime <= options.baseline.baselineTime
  );
}

function readModifiedTime(options: InputReadOptions): AnalysisInput {
  const metric =
    options.kind === 'config-mtime'
      ? 'configMtimeChecks'
      : 'affectingMtimeChecks';
  options.metrics[metric] += 1;
  const mtime = observedMtime(options);
  if (mtime !== undefined && canReusePublishedInput(options, mtime))
    return options.previous!;
  const version =
    mtime === undefined
      ? absentVersion
      : analysisHash([options.baseline?.generation, mtime]);
  return { path: options.path, kind: options.kind, version };
}

function readContent(options: InputReadOptions): AnalysisInput {
  const mtime = observedMtime(options);
  if (mtime === undefined)
    return { path: options.path, kind: options.kind, version: absentVersion };
  if (canReusePublishedInput(options, mtime)) return options.previous!;
  const start = performance.now();
  const bytes = readFileSync(options.path);
  options.metrics.reads += 1;
  options.metrics.readMs += performance.now() - start;
  return observedFile({
    path: options.path,
    kind: options.kind === 'bytes' ? 'bytes' : 'content',
    beforeMtime: mtime,
    captureTextVersions: options.captureTextVersions,
    bytes,
    metrics: options.metrics,
  });
}

export function isRegularFile(stat: Stats | undefined): stat is Stats {
  return stat !== undefined && stat.isFile();
}

export function observedFile(options: {
  path: string;
  kind: 'bytes' | 'content';
  bytes: Buffer;
  beforeMtime: number;
  captureTextVersions?: boolean;
  metrics: AnalysisCacheMetrics;
}): AnalysisInput {
  const start = performance.now();
  const { path, kind, bytes } = options;
  const version = createHash('sha256').update(bytes).digest('hex');
  options.metrics.hashes += 1;
  const input: AnalysisInput = { path, kind, version };
  if (kind === 'content') options.metrics.contentHashes += 1;
  if (kind === 'content' && options.captureTextVersions) {
    const utf8 = analysisHash(bytes.toString('utf8'));
    const text = typeScriptBomText(bytes);
    input.textVersions =
      text === undefined ? { utf8 } : { utf8, typescript: analysisHash(text) };
    options.metrics.textVersionHashes =
      (options.metrics.textVersionHashes ?? 0) + (text === undefined ? 1 : 2);
  }
  options.metrics.hashMs += performance.now() - start;
  if (inputStat(path)?.mtimeMs !== options.beforeMtime)
    throw new AnalysisInputDriftError(path);
  return input;
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
