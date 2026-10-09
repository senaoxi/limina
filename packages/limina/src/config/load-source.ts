import { createHash } from 'node:crypto';
import type { ConfigModuleFile } from '../core/analysis-cache/contracts';
import type { ConfigModuleEvidence } from './load-evidence';

type ModuleSource = string | ArrayBuffer | ArrayBufferView | null | undefined;
type LoadedFile = Omit<ConfigModuleFile, 'contentHash'>;

function sourceText(source: ModuleSource): string | undefined {
  return typeof source === 'string'
    ? source
    : sourceBytes(source)?.toString('utf8');
}
function sourceBytes(
  source: Exclude<ModuleSource, string>,
): Buffer | undefined {
  if (source instanceof ArrayBuffer) return Buffer.from(source);
  return ArrayBuffer.isView(source)
    ? Buffer.from(source.buffer, source.byteOffset, source.byteLength)
    : undefined;
}
function increment(
  evidence: ConfigModuleEvidence,
  name: string,
  count: number,
): void {
  evidence.metrics[name] = (evidence.metrics[name] ?? 0) + count;
}
function recordTransformation(
  evidence: ConfigModuleEvidence,
  file: LoadedFile,
  text: string,
): void {
  file.loadedSource = {
    contentHash: createHash('sha256').update(text).digest('hex'),
  };
  increment(evidence, 'loaderSourceHashes', 1);
  increment(evidence, 'loaderSourceBytes', Buffer.byteLength(text));
}
function hasSourceConflict(
  previous: string | undefined,
  text: string,
): boolean {
  return previous !== undefined && previous !== text;
}
function expectedSource(
  evidence: ConfigModuleEvidence,
  path: string,
): string | undefined {
  return evidence.bytes.get(path)?.toString('utf8');
}
function recordSource(
  evidence: ConfigModuleEvidence,
  file: LoadedFile,
  options: { text: string; hasTransforms: boolean },
): void {
  if (hasSourceConflict(evidence.loadedSources.get(file.path), options.text))
    evidence.unknown.add(`module-source-conflict:${file.path}`);
  evidence.loadedSources.set(file.path, options.text);
  file.sourceKind = sourceKind(evidence, file.path, options.text);
  if (options.text !== expectedSource(evidence, file.path))
    recordChangedSource(evidence, file, options);
}
function recordChangedSource(
  evidence: ConfigModuleEvidence,
  file: LoadedFile,
  options: { text: string; hasTransforms: boolean },
): void {
  recordTransformation(evidence, file, options.text);
  if (!options.hasTransforms)
    evidence.unknown.add(`module-source-transformed:${file.path}`);
}
export function observeLoadedSource(
  evidence: ConfigModuleEvidence,
  file: LoadedFile,
  options: { source: ModuleSource; hasTransforms: boolean },
): void {
  const text = sourceText(options.source);
  if (text === undefined) {
    evidence.unknown.add(`module-source-unobserved:${file.path}`);
    return;
  }
  recordSource(evidence, file, { text, hasTransforms: options.hasTransforms });
}

function sourceKind(
  evidence: ConfigModuleEvidence,
  path: string,
  text: string,
): ConfigModuleFile['sourceKind'] {
  return text === expectedSource(evidence, path) ? 'disk' : 'loader';
}
