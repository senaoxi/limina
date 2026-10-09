import { readFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type {
  ConfigFileDependency,
  ConfigModuleFile,
  ConfigResolution,
} from '../core/analysis-cache/contracts';
import { pathBinding } from '../core/analysis-cache/directory-fingerprint';
import { analysisHash } from '../core/analysis-cache/identity';
import {
  observeConfigResolution,
  type ObservedConfigResolution,
} from './load-resolution';
import { observeLoadedSource } from './load-source';
import { PreloadedCommonJs } from './preloaded-commonjs';
export interface ConfigModuleEvidence {
  loader: string;
  files: Map<string, Omit<ConfigModuleFile, 'contentHash'>>;
  dependencies: Map<string, ConfigFileDependency>;
  bytes: Map<string, Buffer>;
  loadedSources: Map<string, string>;
  bindings: Map<string, string>;
  resolutions: Map<string, ConfigResolution>;
  requestBindings: Map<string, string>;
  unknown: Set<string>;
  warned: Set<string>;
  metrics: Record<string, number>;
}
function isAbsent(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes(
    String((error as NodeJS.ErrnoException).code),
  );
}
function metadataFromFile(path: string): ConfigModuleFile['metadata'] {
  const stat = statSync(path);
  if (!stat.isFile())
    throw new Error(
      `Limina configuration input is not a regular file: ${path}`,
    );
  return {
    kind: 'file',
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
  };
}
export function configModuleMetadata(
  path: string,
): ConfigModuleFile['metadata'] {
  try {
    return metadataFromFile(path);
  } catch (error) {
    if (isAbsent(error)) return { kind: 'missing' };
    throw error;
  }
}
function assertFileCaptured(file: Omit<ConfigModuleFile, 'contentHash'>): void {
  const isCurrent = [
    isDeepStrictEqual(configModuleMetadata(file.path), file.metadata),
    analysisHash(pathBinding(file.path)) === file.binding,
  ].every(Boolean);
  if (!isCurrent)
    throw new Error(
      `Limina configuration module changed during evaluation: ${file.path}. Run the command again.`,
    );
}
export class ConfigLoadEvidence implements ConfigModuleEvidence {
  readonly #baseLoader: string;
  readonly #hasTransforms: boolean;
  readonly #preloaded = new PreloadedCommonJs();
  loader: string;
  readonly inputs: Map<string, string | null> = new Map();
  readonly dependencies: ConfigModuleEvidence['dependencies'] = new Map();
  readonly files: ConfigModuleEvidence['files'] = new Map();
  readonly bytes: Map<string, Buffer> = new Map<string, Buffer>();
  readonly loadedSources: Map<string, string> = new Map<string, string>();
  readonly bindings: Map<string, string> = new Map<string, string>();
  readonly resolutions: Map<string, ConfigResolution> = new Map<
    string,
    ConfigResolution
  >();
  readonly requestBindings: Map<string, string> = new Map<string, string>();
  readonly unknown: Set<string> = new Set<string>();
  readonly warned: Set<string> = new Set<string>();
  readonly metrics: Record<string, number> = {
    captureReads: 0,
    evaluationMs: 0,
    extraReads: 0,
  };
  constructor(loader: string, hasTransforms = false) {
    this.loader = loader;
    this.#baseLoader = loader;
    this.#hasTransforms = hasTransforms;
  }
  #read(file: Omit<ConfigModuleFile, 'contentHash'>): void {
    if (file.metadata.kind === 'missing') {
      this.inputs.set(file.path, null);
      return;
    }
    const bytes = readFileSync(file.path);
    this.metrics.captureReads += 1;
    assertFileCaptured(file);
    this.bytes.set(file.path, bytes);
    this.inputs.set(file.path, bytes.toString('utf8'));
  }
  #newFile(path: string, role: ConfigModuleFile['role']): void {
    const file = {
      path,
      role,
      binding: analysisHash(pathBinding(path)),
      metadata: configModuleMetadata(path),
      format: null,
    };
    if ([file.metadata.kind === 'missing', role === 'module'].every(Boolean))
      throw new Error(`Loaded Limina configuration module is missing: ${path}`);
    this.files.set(path, file);
    this.bindings.set(path, file.binding);
    this.#read(file);
  }
  #format(
    file: Omit<ConfigModuleFile, 'contentHash'>,
    format: string | null | undefined,
  ): void {
    const effectiveFormat = format ?? '';
    const currentFormat = nullableFormat(format);
    this.#recordFormatConflict(file, currentFormat);
    file.format = mergedFormat(file.format, currentFormat);
    if (
      ![
        'module',
        'module-typescript',
        'commonjs',
        'commonjs-typescript',
        'json',
      ].includes(effectiveFormat)
    )
      this.unknown.add(`module-format-unknown:${file.path}`);
  }
  #recordFormatConflict(
    file: Omit<ConfigModuleFile, 'contentHash'>,
    currentFormat: string | null,
  ): void {
    if (hasFormatConflict(file.format, currentFormat))
      this.unknown.add(`module-format-conflict:${file.path}`);
  }
  #captureFile(path: string, role: ConfigModuleFile['role']): void {
    const existing = this.files.get(path);
    if (existing === undefined) this.#newFile(path, role);
    else promoteModule(existing, role);
  }
  #assertInput(file: string, bytes: Buffer): void {
    this.metrics.evaluationValidationReads =
      (this.metrics.evaluationValidationReads ?? 0) + 1;
    const isCurrent = [
      readFileSync(file).equals(bytes),
      analysisHash(pathBinding(file)) === this.bindings.get(file),
    ].every(Boolean);
    if (!isCurrent)
      throw new Error(
        `Limina configuration module changed during evaluation: ${file}. Run the command again.`,
      );
  }
  assertEntryNotPreloaded(path: string): void {
    this.#preloaded.assertEntry(path);
  }
  capture(path: string, role: ConfigModuleFile['role'] = 'module'): void {
    if (role === 'module') this.#preloaded.assertModule(path);
    this.#captureFile(path, role);
  }
  recordLoaderURL(url: string): void {
    this.loader = JSON.stringify([this.#baseLoader, url]);
  }
  aliasEntry(logical: string, actual: string): void {
    if (logical === actual) return;
    const file = this.files.get(actual)!;
    file.logicalPath = logical;
    file.logicalBinding = this.bindings.get(logical)!;
    this.files.delete(logical);
  }
  child(path: string | undefined, url: string): void {
    if (path !== undefined) this.capture(path);
    else if (!url.startsWith('node:'))
      this.unknown.add('module-scheme-unknown');
  }
  loaded(
    path: string | undefined,
    result: {
      format: string | null | undefined;
      source?: string | ArrayBuffer | ArrayBufferView | null;
    },
  ): void {
    if (path === undefined) return;
    const file = this.files.get(path);
    if (!isModuleFile(file)) return;
    this.#format(file, result.format);
    observeLoadedSource(this, file, {
      source: result.source,
      hasTransforms: this.#hasTransforms,
    });
  }

  resolve(raw: ObservedConfigResolution): void {
    observeConfigResolution(this, raw);
  }
  assertStable(): void {
    for (const [file, bytes] of this.bytes) this.#assertInput(file, bytes);
    for (const file of this.files.values()) assertMissingAnchor(file);
    assertConfigRequestBindings(this);
  }
}
export function assertConfigRequestBindings(
  evidence: ConfigModuleEvidence,
): void {
  for (const [file, binding] of evidence.requestBindings)
    if (analysisHash(pathBinding(file)) !== binding)
      throw new Error(
        `Limina configuration resolution binding changed during execution: ${file}. Run the command again to load the new configuration.`,
      );
}

function promoteModule(
  file: Omit<ConfigModuleFile, 'contentHash'>,
  role: ConfigModuleFile['role'],
): void {
  if (role === 'module') file.role = role;
}
function nullableFormat(format: string | null | undefined): string | null {
  return format ?? null;
}
function isModuleFile(
  file: Omit<ConfigModuleFile, 'contentHash'> | undefined,
): file is Omit<ConfigModuleFile, 'contentHash'> {
  return file?.role === 'module';
}

function hasFormatConflict(
  previous: string | null,
  current: string | null,
): boolean {
  return previous !== null && previous !== current;
}
function mergedFormat(
  previous: string | null,
  current: string | null,
): string | null {
  return (
    [previous, current].find((format) =>
      ['module', 'module-typescript'].includes(format ?? ''),
    ) ?? current
  );
}
function assertMissingAnchor(
  file: Omit<ConfigModuleFile, 'contentHash'>,
): void {
  if (file.metadata.kind !== 'missing') return;
  const isCurrent = [
    configModuleMetadata(file.path).kind === 'missing',
    analysisHash(pathBinding(file.path)) === file.binding,
  ].every(Boolean);
  if (!isCurrent)
    throw new Error(
      `Limina configuration module changed during evaluation: ${file.path}. Run the command again.`,
    );
}
