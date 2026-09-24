import type { ImportRecord } from '#core/import-graph/context';
import type { PackageManifest } from '#core/workspace/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ResolverFactory } from 'oxc-resolver';
import type ts from 'typescript';
import type { RuntimeEvidence } from '../core/import-analysis/evidence';
import { ResourceNodeCompatibility } from './resource-node-compatibility';
import { resolveResourceWithNode } from './resource-node-resolution';

interface ResourceRequest {
  importRecord: ImportRecord;
  options: ts.CompilerOptions;
  resolutionMode: string;
}

function getOccurrenceMode(request: ResourceRequest): 'import' | 'require' {
  if (['1', 'require'].includes(request.resolutionMode)) return 'require';
  if (['99', 'import'].includes(request.resolutionMode)) return 'import';
  return getSyntaxMode(request.importRecord);
}

function getSyntaxMode(record: ImportRecord): 'import' | 'require' {
  return ['commonjs', 'require-resolve', 'import-equals'].includes(record.kind)
    ? 'require'
    : 'import';
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || path.isAbsolute(specifier);
}

function resolveLocalResource(record: ImportRecord): RuntimeEvidence {
  const checkedPath = normalizeAbsolutePath(
    path.resolve(path.dirname(record.filePath), record.specifier),
  );
  return existsSync(checkedPath)
    ? { authority: 'filesystem', filePath: checkedPath, kind: 'file' }
    : { checkedPath, kind: 'missing' };
}

function getPhysicalEvidence(
  resolved: string | null | undefined,
  authority: 'oxc' | 'package-export',
): RuntimeEvidence {
  if (!resolved) return { kind: 'missing' };
  return existsSync(resolved)
    ? { authority, filePath: normalizeAbsolutePath(resolved), kind: 'file' }
    : { kind: 'missing' };
}

function getResourceCacheKey(request: ResourceRequest): string {
  return JSON.stringify([
    'runtime-resource',
    request.importRecord.filePath,
    request.importRecord.specifier,
    getOccurrenceMode(request),
    request.options.customConditions ?? [],
    request.options.preserveSymlinks ?? false,
  ]);
}

export class ResourceResolver {
  readonly #nodeCompatibility: ResourceNodeCompatibility;

  constructor(
    readOwnerManifest?: (manifestPath: string) => PackageManifest | undefined,
  ) {
    this.#nodeCompatibility = new ResourceNodeCompatibility(readOwnerManifest);
  }
  readonly #resolvers = new Map<string, ResolverFactory>();
  readonly #results = new Map<string, RuntimeEvidence>();

  #getResolver(request: ResourceRequest): ResolverFactory {
    const mode = getOccurrenceMode(request);
    const conditionNames = [
      'node',
      mode,
      ...(request.options.customConditions ?? []),
    ];
    const symlinks = !request.options.preserveSymlinks;
    const key = JSON.stringify([
      'runtime-resource',
      mode,
      conditionNames,
      symlinks,
    ]);
    const cached = this.#resolvers.get(key);
    if (cached !== undefined) return cached;
    const resolver = new ResolverFactory({
      conditionNames,
      extensions: [],
      nodePath: false,
      symlinks,
    });
    this.#resolvers.set(key, resolver);
    return resolver;
  }

  #resolvePackage(request: ResourceRequest): RuntimeEvidence {
    const { filePath, specifier } = request.importRecord;
    const result = this.#getResolver(request).sync(
      path.dirname(filePath),
      specifier,
    );
    if (
      result.packageJsonPath === undefined ||
      this.#nodeCompatibility.requiresNode({
        filePath,
        specifier,
        packageJsonPath: result.packageJsonPath,
      })
    ) {
      return this.#resolveExactImport(request);
    }
    return getPhysicalEvidence(result.path, 'oxc');
  }

  #resolveExactImport(request: ResourceRequest): RuntimeEvidence {
    const resolved = resolveResourceWithNode({
      conditions: request.options.customConditions ?? [],
      filePath: request.importRecord.filePath,
      mode: getOccurrenceMode(request),
      preserveSymlinks: request.options.preserveSymlinks ?? false,
      specifier: request.importRecord.specifier,
    });
    return getPhysicalEvidence(resolved, 'package-export');
  }

  resolve(request: ResourceRequest): RuntimeEvidence {
    const { specifier } = request.importRecord;
    const key = getResourceCacheKey(request);
    const cached = this.#results.get(key);
    if (cached !== undefined) return cached;
    const result = isLocalSpecifier(specifier)
      ? resolveLocalResource(request.importRecord)
      : this.#resolvePackage(request);
    this.#results.set(key, result);
    return result;
  }

  dispose(): void {
    for (const resolver of this.#resolvers.values()) resolver.clearCache();
    this.#nodeCompatibility.clear();
    this.#resolvers.clear();
    this.#results.clear();
  }
}
