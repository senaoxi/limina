import { compareCodeUnits } from '#utils/collections';
import { createHash } from 'node:crypto';
import type { ConfigModuleEvidence } from '../config/input-observation';
import type {
  ConfigModuleFile,
  ConfigModuleSnapshot,
} from '../core/analysis-cache/contracts';
export { compareConfigModules } from './config-module-comparison';
type LoadedFile = Omit<ConfigModuleFile, 'contentHash'>;
function canReuseHash(
  file: LoadedFile,
  old: ConfigModuleFile | undefined,
): old is ConfigModuleFile {
  if (old === undefined) return false;
  return [
    old.binding === file.binding,
    old.role === file.role,
    old.metadata.kind === file.metadata.kind,
    old.logicalBinding === file.logicalBinding,
    old.logicalPath === file.logicalPath,
    old.contentHash !== null,
    old.metadata.mtimeMs !== undefined,
    old.metadata.mtimeMs === file.metadata.mtimeMs,
  ].every(Boolean);
}
class ConfigModuleSnapshotBuilder {
  readonly #evidence: ConfigModuleEvidence;
  readonly #old: Map<string, ConfigModuleFile>;
  readonly #reasons: Set<string>;
  constructor(evidence: ConfigModuleEvidence, previous?: ConfigModuleSnapshot) {
    this.#evidence = evidence;
    this.#old = new Map(previous?.files.map((file) => [file.path, file]));
    this.#reasons = new Set(evidence.unknown);
  }
  #increment(name: string, value = 1): void {
    this.#evidence.metrics[name] = (this.#evidence.metrics[name] ?? 0) + value;
  }
  #hashBytes(file: LoadedFile): string | null {
    const bytes = this.#evidence.bytes.get(file.path);
    if (bytes === undefined) {
      this.#reasons.add(`module-content-unknown:${file.path}`);
      return null;
    }
    this.#increment('hashes');
    this.#increment('hashBytes', bytes.length);
    return createHash('sha256').update(bytes).digest('hex');
  }
  #hash(file: LoadedFile): string | null {
    if (file.metadata.kind === 'missing') return null;
    const old = this.#old.get(file.path);
    if (canReuseHash(file, old)) {
      this.#increment('mtimeHits');
      return old.contentHash;
    }
    return this.#hashBytes(file);
  }
  #qualify(record: LoadedFile): void {
    if (record.format === null)
      this.#reasons.add(`module-format-unobserved:${record.path}`);
    if (record.sourceKind === undefined)
      this.#reasons.add(`module-source-unobserved:${record.path}`);
  }
  #file(record: LoadedFile): ConfigModuleFile {
    if (record.role === 'module') this.#qualify(record);
    return { ...record, contentHash: this.#hash(record) };
  }
  snapshot(): ConfigModuleSnapshot {
    const files = Array.from(this.#evidence.files.values(), (file) =>
      this.#file(file),
    ).sort((a, b) => compareCodeUnits(a.path, b.path));
    const resolutions = Array.from(this.#evidence.resolutions)
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([, edge]) => edge);
    const dependencies = Array.from(this.#evidence.dependencies.values()).sort(
      (a, b) => compareCodeUnits(a.path, b.path),
    );
    Object.assign(this.#evidence.metrics, {
      files: files.length,
      modules: files.filter((file) => file.role === 'module').length,
      resolutions: resolutions.length,
      explicitDependencies: dependencies.length,
    });
    return {
      loader: this.#evidence.loader,
      files,
      resolutions,
      dependencies,
      complete: this.#reasons.size === 0,
      otherUnknownReasons: [...this.#reasons].sort(compareCodeUnits),
    };
  }
}
export function captureConfigModuleSnapshot(
  evidence: ConfigModuleEvidence,
  previous?: ConfigModuleSnapshot,
): ConfigModuleSnapshot {
  return new ConfigModuleSnapshotBuilder(evidence, previous).snapshot();
}
