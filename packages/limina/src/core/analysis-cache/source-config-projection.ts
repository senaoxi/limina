import type { ResolvedConfigCacheRequest } from '#utils/resolved-config-cache';
import { createHash } from 'node:crypto';
import {
  captureResolvedConfig,
  type ResolvedConfigProjection,
  restoreResolvedConfig,
} from '../../checker/resolved-config';
import type {
  AnalysisSnapshot,
  DiscoveryRecord,
  SourceConfigAuthority,
  SourceConfigProjectionRecord,
} from './contracts';
import { decodeData, encodeData } from './data-codec';
import { EpochInputReplay, EpochInputs } from './epoch-inputs';
import { analysisHash } from './identity';
import {
  type CacheOrigin,
  recordCacheHit,
  recordCacheMiss,
} from './profile-decisions';
import { retainData } from './snapshot-records';

function hasSameSourceConfigSemantics(
  before: SourceConfigAuthority,
  after: SourceConfigAuthority,
): boolean {
  return (
    before.family === after.family &&
    before.provider === after.provider &&
    before.toolchain === after.toolchain
  );
}

function isCompilerRead(record: DiscoveryRecord): boolean {
  const { descriptor, path, key } = record;
  switch (descriptor.kind) {
    case 'ts-directory': {
      return (
        path === descriptor.arguments[0] &&
        key === JSON.stringify(['config-files', descriptor.arguments])
      );
    }
    case 'config-text':
    case 'file-digest':
    case 'file':
    case 'directory':
    case 'directories':
    case 'realpath': {
      return (
        path === descriptor.path &&
        key === JSON.stringify([descriptor.kind, path])
      );
    }
    default: {
      return false;
    }
  }
}

function projectionIntegrity(
  key: string,
  authority: SourceConfigAuthority,
  data: string,
  reads: readonly DiscoveryRecord[],
): string {
  return analysisHash([
    key,
    authority.family,
    authority.provider,
    authority.toolchain,
    data,
    reads.map(({ key, path, version, binding }) => [
      key,
      path,
      version,
      binding,
    ]),
  ]);
}

function hasCompilerReads(
  reads: readonly DiscoveryRecord[],
  path: string,
): boolean {
  return (
    new Set(reads.map(({ key }) => key)).size === reads.length &&
    reads.every(isCompilerRead) &&
    reads.some(
      (read) => read.descriptor.kind === 'config-text' && read.path === path,
    )
  );
}

function hasConfigClosure(
  value: ResolvedConfigProjection,
  reads: EpochInputs,
): boolean {
  return (
    value.configClosure.length > 0 &&
    value.configClosure.every(({ filePath, contentHash }) => {
      const text = reads.configText(filePath);
      return (
        text !== undefined &&
        createHash('sha256').update(text).digest('hex') === contentHash
      );
    })
  );
}

export class SourceConfigProjectionCache {
  readonly #records: AnalysisSnapshot['sourceConfigs'] = {};
  readonly #revoked = new Set<string>();
  readonly #previous: AnalysisSnapshot | undefined;
  readonly #previousOrigin: CacheOrigin;
  readonly #packageScopes: () => AnalysisSnapshot['header']['packageScopes'];
  readonly #invalidate: (file: string) => void;

  constructor(options: {
    previous?: AnalysisSnapshot;
    previousOrigin: CacheOrigin;
    packageScopes(): AnalysisSnapshot['header']['packageScopes'];
    invalidate(file: string): void;
  }) {
    this.#previous = options.previous;
    this.#previousOrigin = options.previousOrigin;
    this.#packageScopes = options.packageScopes;
    this.#invalidate = options.invalidate;
  }

  #hasSameScope(file: string): boolean {
    const before = this.#previous?.header.packageScopes;
    const after = this.#packageScopes();
    const scope = after.configs[file];
    if (
      before === undefined ||
      scope?.role !== 'source' ||
      before.configs[file]?.role !== 'source' ||
      before.configs[file].scope !== scope.scope
    )
      return false;
    const oldManifest = before.manifests[scope.scope];
    const newManifest = after.manifests[scope.scope];
    return (
      oldManifest !== undefined &&
      newManifest !== undefined &&
      oldManifest.version === newManifest.version &&
      oldManifest.role === newManifest.role &&
      oldManifest.directory === newManifest.directory
    );
  }

  #restoreRecord(
    file: string,
    key: string,
    authority: SourceConfigAuthority,
    record: SourceConfigProjectionRecord,
  ):
    | 'vue-root-query-changed'
    | undefined
    | { value: ResolvedConfigProjection; reads: EpochInputs } {
    if (
      !hasCompilerReads(record.reads, file) ||
      record.integrity !==
        projectionIntegrity(key, authority, record.data, record.reads)
    )
      return undefined;
    const reads = new EpochInputs();
    try {
      const replay = new EpochInputReplay({ strictConfigContents: true });
      const isCurrent = reads.validateSynchronous(record.reads, replay);
      if (
        !isCurrent &&
        (authority.family !== 'vue' ||
          record.reads.some((read) =>
            read.descriptor.kind === 'ts-directory'
              ? replay.readSynchronous(read)?.binding !== read.binding
              : !reads.validateSynchronous([read], replay),
          ))
      )
        return undefined;
      const data = decodeData(JSON.parse(record.data));
      const value = restoreResolvedConfig(data, file, (path) =>
        reads.configText(path),
      );
      if (value === undefined || !hasConfigClosure(value, reads))
        return undefined;
      // A lower-priority sibling can change a directory query without changing
      // TypeScript's selected roots.
      return isCurrent ? { value, reads } : 'vue-root-query-changed';
    } catch {
      return undefined;
    }
  }

  recordAuthority(file: string, authority: SourceConfigAuthority): boolean {
    const prior = this.#previous?.sourceConfigs[file];
    const current = this.#records[file];
    this.#records[file] = {
      authority,
      projections:
        current === undefined ||
        !hasSameSourceConfigSemantics(current.authority, authority)
          ? {}
          : current.projections,
    };
    const isReusable =
      prior !== undefined &&
      hasSameSourceConfigSemantics(prior.authority, authority);
    if (isReusable)
      recordCacheHit('source-config-authority', this.#previousOrigin, file);
    else
      recordCacheMiss(
        'source-config-authority',
        prior === undefined ? 'authority-absent' : 'semantic-authority-changed',
        { file, absent: prior === undefined || undefined },
      );
    return isReusable;
  }

  revoke(file: string): void {
    this.#revoked.add(file);
  }

  restore(
    request: ResolvedConfigCacheRequest,
  ): { value: ResolvedConfigProjection; reads: EpochInputs } | undefined {
    const file = request.configPath;
    const target = this.#records[file];
    const prior = this.#previous?.sourceConfigs[file];
    if (
      target === undefined ||
      prior === undefined ||
      this.#revoked.has(file) ||
      !this.#hasSameScope(file) ||
      !hasSameSourceConfigSemantics(prior.authority, target.authority)
    )
      return undefined;
    const key = analysisHash(request.key);
    const record = prior.projections[key];
    if (record === undefined) {
      recordCacheMiss('resolved-config-projection', 'projection-absent', {
        file,
        absent: true,
      });
      return undefined;
    }
    const restored = this.#restoreRecord(file, key, target.authority, record);
    if (restored === undefined || restored === 'vue-root-query-changed') {
      if (restored === undefined) this.#invalidate(file);
      recordCacheMiss(
        'resolved-config-projection',
        'projection-input-changed',
        { file },
      );
      return undefined;
    }
    target.projections[key] = record;
    recordCacheHit('resolved-config-projection', this.#previousOrigin, file);
    return restored;
  }

  capture(
    request: ResolvedConfigCacheRequest,
    value: ResolvedConfigProjection,
    reads: EpochInputs,
  ): boolean {
    const file = request.configPath;
    const target = this.#records[file];
    if (
      target === undefined ||
      this.#packageScopes().configs[file]?.role !== 'source'
    )
      return false;
    const observations = reads.snapshot();
    if (
      observations === undefined ||
      !hasCompilerReads(observations, file) ||
      !hasConfigClosure(value, reads)
    )
      return false;
    const projection = captureResolvedConfig(value);
    if (projection === undefined) return false;
    const data = JSON.stringify(encodeData(projection));
    const key = analysisHash(request.key);
    const integrity = projectionIntegrity(
      key,
      target.authority,
      data,
      observations,
    );
    target.projections[key] = retainData(
      this.#previous?.sourceConfigs[file]?.projections[key],
      { data, reads: observations, integrity },
    );
    return true;
  }

  snapshotRecords(): AnalysisSnapshot['sourceConfigs'] {
    return Object.fromEntries(
      Object.entries(this.#records).map(([file, record]) => [
        file,
        retainData(this.#previous?.sourceConfigs[file], record),
      ]),
    );
  }
}
