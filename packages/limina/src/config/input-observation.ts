import { normalizeAbsolutePath } from '#utils/path';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { captureFileDependencies } from './file-dependencies';
import { ConfigLoadEvidence, type ConfigModuleEvidence } from './load-evidence';
import type { ObservedConfigResolution } from './load-resolution';
import { ConfigLoadURLs } from './load-urls';
import type { LiminaConfig, ResolvedLiminaConfig } from './root-types';

export { configModuleMetadata } from './load-evidence';
export type { ConfigModuleEvidence } from './load-evidence';
const bindings = new WeakMap<
  ResolvedLiminaConfig,
  ReadonlyMap<string, string | null>
>();
const observations = new WeakMap<
  ReadonlyMap<string, string | null>,
  ConfigLoadEvidence
>();
const activeObservations = new Set<ConfigLoadEvidence>();
function isConfigDescendant(
  parentURL: string | undefined,
  evidence: ConfigLoadEvidence,
  urls: ConfigLoadURLs,
): boolean {
  const parent = urls.physicalPath(parentURL);
  return parent !== undefined && evidence.inputs.has(parent);
}

function declaredFileDependencies(
  cache: LiminaConfig['cache'],
): readonly string[] | undefined {
  return typeof cache === 'object' ? cache.dependencies : undefined;
}

/**
Observe the actual loader, including imports executed by a config factory.
*/
export async function observeConfigLoad<T extends LiminaConfig>(
  path: string,
  load: (entryURL: string) => Promise<T>,
  options: {
    initialInputs?: readonly string[];
    loader?: string;
    unknownReasons?: readonly string[];
    namespace?: string;
    hasTransforms?: boolean;
  } = {},
): Promise<{ value: T; inputs: ReadonlyMap<string, string | null> }> {
  const observationStart = performance.now();
  const evidence = new ConfigLoadEvidence(
    options.loader ?? 'native',
    options.hasTransforms,
  );
  evidence.assertEntryNotPreloaded(path);
  recordUnknownReasons(evidence, options.unknownReasons);
  observations.set(evidence.inputs, evidence);
  evidence.capture(normalizeAbsolutePath(path));
  captureAnchors(evidence, options.initialInputs);
  const urls = new ConfigLoadURLs(options.namespace);
  let isEntryLoaded = false;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      return measureHook(evidence, () => {
        // Node 22 CJS supplies an iterable SafeSet rather than an array.
        const conditions = [...context.conditions];
        // createRequire() may choose a synthetic parent that was never loaded.
        // Once evaluation starts, observe the entire invocation's loading phase.
        if (
          !isEntryLoaded &&
          !isConfigDescendant(context.parentURL, evidence, urls)
        ) {
          return resolveEntryResult(
            {
              specifier,
              result,
              entryPath: path,
              conditions,
            },
            evidence,
            urls,
          );
        }
        recordResolution(evidence, urls, {
          parentURL: context.parentURL,
          specifier,
          resolvedURL: result.url,
          conditions,
          importAttributes: context.importAttributes,
        });
        evidence.child(urls.physicalPath(result.url), result.url);
        return urls.observedResult(result, conditions);
      });
    },
    load(url, context, next) {
      measureHook(evidence, () => {
        if (
          isEntryLoaded ||
          !isEntryURL({ url, entryPath: path }, evidence, urls)
        )
          return;
        isEntryLoaded = true;
        observeEntryLoad({ url, entryPath: path }, evidence, urls);
      });
      const result = next(url, context);
      measureHook(evidence, () =>
        evidence.loaded(urls.physicalPath(url), result),
      );
      return result;
    },
  });
  beginObservation(evidence);
  try {
    const start = performance.now();
    const value = await load(pathToFileURL(path).href);
    evidence.metrics.evaluationMs = performance.now() - start;
    captureFileDependencies(
      evidence,
      path,
      declaredFileDependencies(value.cache),
    );
    evidence.assertStable();
    evidence.metrics.observationMs =
      performance.now() - observationStart - evidence.metrics.evaluationMs;
    return { value, inputs: evidence.inputs };
  } finally {
    hook.deregister();
    activeObservations.delete(evidence);
  }
}
function measureHook<T>(evidence: ConfigLoadEvidence, observe: () => T): T {
  const start = performance.now();
  try {
    return observe();
  } finally {
    evidence.metrics.hookMs =
      (evidence.metrics.hookMs ?? 0) + performance.now() - start;
  }
}
function isEntryURL(
  request: { url: string; entryPath: string },
  evidence: ConfigLoadEvidence,
  urls: ConfigLoadURLs,
): boolean {
  const physical = urls.physicalPath(request.url);
  if (physical === undefined) return false;
  const logical = normalizeAbsolutePath(request.entryPath);
  return [physical, evidence.files.get(physical)?.logicalPath].includes(
    logical,
  );
}
function observeEntryLoad(
  request: { url: string; entryPath: string },
  evidence: ConfigLoadEvidence,
  urls: ConfigLoadURLs,
): void {
  const actual = urls.physicalPath(request.url);
  evidence.child(actual, request.url);
  bindEntryAlias(evidence, normalizeAbsolutePath(request.entryPath), actual);
  recordLoaderURL(evidence, urls.original(request.url));
}
function observeEntryResolution<T extends { url: string }>(
  request: { specifier: string; result: T; entryPath: string },
  evidence: ConfigLoadEvidence,
  urls: ConfigLoadURLs,
): T {
  const logical = normalizeAbsolutePath(request.entryPath);
  const actual = urls.physicalPath(request.result.url);
  if (actual === undefined) return request.result;
  if (!isEntryRequest(request.specifier, logical, urls)) return request.result;
  evidence.child(actual, request.result.url);
  bindEntryAlias(evidence, logical, actual);
  recordLoaderURL(evidence, urls.original(request.result.url));
  return request.result;
}
function isEntryRequest(
  specifier: string,
  entry: string,
  urls: ConfigLoadURLs,
): boolean {
  if (specifier.startsWith('tsx://'))
    return isScopedEntryRequest(specifier, entry, urls);
  const physical = specifier.startsWith('file:')
    ? urls.physicalPath(specifier)
    : normalizeAbsolutePath(urls.original(specifier));
  return physical === entry;
}

function isScopedEntryRequest(
  specifier: string,
  entry: string,
  urls: ConfigLoadURLs,
): boolean {
  try {
    return isEntryRequest(
      JSON.parse(specifier.slice(6)).specifier,
      entry,
      urls,
    );
  } catch {
    return false;
  }
}

function bindEntryAlias(
  evidence: ConfigLoadEvidence,
  logical: string,
  actual: string | undefined,
): void {
  if (actual !== undefined) evidence.aliasEntry(logical, actual);
}
function captureAnchors(
  evidence: ConfigLoadEvidence,
  files: readonly string[] | undefined,
): void {
  const anchors = files ?? [];
  for (const file of anchors)
    evidence.capture(normalizeAbsolutePath(file), 'anchor');
}
export function bindConfigInputs(
  config: ResolvedLiminaConfig,
  inputs: ReadonlyMap<string, string | null>,
): ResolvedLiminaConfig {
  bindings.set(config, inputs);
  return config;
}
export function getConfigInputs(
  config: ResolvedLiminaConfig,
): ReadonlyMap<string, string | null> | undefined {
  return bindings.get(config);
}
export function getConfigModuleEvidence(
  config: ResolvedLiminaConfig,
): ConfigModuleEvidence | undefined {
  const inputs = bindings.get(config);
  return inputs === undefined ? undefined : observations.get(inputs);
}
export function getConfigBindings(
  config: ResolvedLiminaConfig,
): ReadonlyMap<string, string> | undefined {
  return getConfigModuleEvidence(config)?.bindings;
}

function recordUnknownReasons(
  evidence: ConfigLoadEvidence,
  reasons: readonly string[] | undefined,
): void {
  const unknown = reasons ?? [];
  for (const reason of unknown) evidence.unknown.add(reason);
}

function beginObservation(evidence: ConfigLoadEvidence): void {
  for (const other of activeObservations) {
    other.unknown.add('overlapping-config-loads');
    evidence.unknown.add('overlapping-config-loads');
  }
  activeObservations.add(evidence);
}

function recordLoaderURL(evidence: ConfigLoadEvidence, url: string): void {
  if (url.startsWith('file:')) evidence.recordLoaderURL(url);
}

function recordResolution(
  evidence: ConfigLoadEvidence,
  urls: ConfigLoadURLs,
  raw: Omit<ObservedConfigResolution, 'parentURL'> & { parentURL?: string },
): void {
  if (raw.parentURL === undefined) {
    evidence.unknown.add('resolution-parent-unobserved');
    return;
  }
  evidence.resolve({
    ...raw,
    parentURL: urls.original(raw.parentURL),
    specifier: urls.original(raw.specifier),
    resolvedURL: urls.original(raw.resolvedURL),
  });
}
function resolveEntryResult<T extends { url: string }>(
  request: {
    specifier: string;
    result: T;
    entryPath: string;
    conditions: readonly string[];
  },
  evidence: ConfigLoadEvidence,
  urls: ConfigLoadURLs,
): T {
  const entry = observeEntryResolution(request, evidence, urls);
  return urls.physicalPath(entry.url) ===
    normalizeAbsolutePath(request.entryPath)
    ? urls.observedResult(entry, request.conditions)
    : entry;
}
