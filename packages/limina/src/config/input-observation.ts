import { normalizeAbsolutePath } from '#utils/path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pathBinding } from '../core/analysis-cache/directory-fingerprint';
import { analysisHash } from '../core/analysis-cache/identity';
import type { ResolvedLiminaConfig } from './root-types';

const bindings = new WeakMap<
  ResolvedLiminaConfig,
  ReadonlyMap<string, string>
>();

function physicalPath(url: string | undefined): string | undefined {
  return url?.startsWith('file:')
    ? normalizeAbsolutePath(fileURLToPath(url))
    : undefined;
}

const requireForConfig = createRequire(import.meta.url);
const observedBindings = new WeakMap<
  ReadonlyMap<string, string>,
  ReadonlyMap<string, string>
>();
function capture(path: string, inputs: Map<string, string>): void {
  if (inputs.has(path)) return;
  const identity = observedBindings.get(inputs) as Map<string, string>;
  identity.set(path, analysisHash(pathBinding(path)));
  inputs.set(path, readFileSync(path, 'utf8'));
  const previous = requireForConfig.cache[requireForConfig.resolve(path)];
  if (previous !== undefined) clearCommonJsTree(previous, new Set());
}

function clearCommonJsTree(module: NodeJS.Module, seen: Set<string>): void {
  if (seen.has(module.id)) return;
  seen.add(module.id);
  for (const child of module.children) clearCommonJsTree(child, seen);
  delete requireForConfig.cache[module.id];
}

/**
Observe the actual loader, including imports executed by a config factory.
*/
export async function observeConfigLoad<T>(
  path: string,
  load: () => Promise<T>,
  initialInputs: readonly string[] = [],
): Promise<{ value: T; inputs: ReadonlyMap<string, string> }> {
  const inputs = new Map<string, string>();
  observedBindings.set(inputs, new Map());
  const invocation = randomUUID();
  capture(normalizeAbsolutePath(path), inputs);
  for (const file of initialInputs)
    capture(normalizeAbsolutePath(file), inputs);
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (!isConfigDescendant(context.parentURL, inputs)) return result;
      recordChild(result.url, inputs);
      return versionedResult(result, invocation);
    },
  });
  try {
    const value = await load();
    assertConfigInputsCurrent(inputs);
    return { value, inputs };
  } finally {
    hook.deregister();
  }
}

function isConfigDescendant(
  parentURL: string | undefined,
  inputs: ReadonlyMap<string, string>,
): boolean {
  const parent = physicalPath(parentURL);
  return parent !== undefined && inputs.has(parent);
}
function versionedResult<T extends { url: string }>(
  result: T,
  invocation: string,
): T {
  if (!result.url.startsWith('file:')) return result;
  const url = new URL(result.url);
  url.searchParams.set('liminaInvocation', invocation);
  return { ...result, url: url.href };
}
function recordChild(url: string, inputs: Map<string, string>): void {
  const child = physicalPath(url);
  if (child === undefined) return;
  capture(child, inputs);
}

export function bindConfigInputs(
  config: ResolvedLiminaConfig,
  inputs: ReadonlyMap<string, string>,
): ResolvedLiminaConfig {
  bindings.set(config, inputs);
  return config;
}

export function getConfigInputs(
  config: ResolvedLiminaConfig,
): ReadonlyMap<string, string> | undefined {
  return bindings.get(config);
}

export function getConfigBindings(
  config: ResolvedLiminaConfig,
): ReadonlyMap<string, string> | undefined {
  const inputs = bindings.get(config);
  return inputs === undefined ? undefined : observedBindings.get(inputs);
}
function assertConfigInputsCurrent(inputs: ReadonlyMap<string, string>): void {
  const identities = observedBindings.get(inputs)!;
  for (const [file, text] of inputs) {
    const isCurrent = [
      readFileSync(file, 'utf8') === text,
      analysisHash(pathBinding(file)) === identities.get(file),
    ].every(Boolean);
    if (!isCurrent)
      throw new Error(
        `Limina configuration module changed during evaluation: ${file}. Run the command again.`,
      );
  }
}
