import { normalizeAbsolutePath } from '#utils/path';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ResolvedLiminaConfig } from './root-types';

const bindings = new WeakMap<
  ResolvedLiminaConfig,
  ReadonlyMap<string, string>
>();
const knownChildren = new Map<string, Set<string>>();

function physicalPath(url: string | undefined): string | undefined {
  return url?.startsWith('file:')
    ? normalizeAbsolutePath(fileURLToPath(url))
    : undefined;
}

function addChild(parent: string, child: string): void {
  const children = knownChildren.get(parent) ?? new Set<string>();
  children.add(child);
  knownChildren.set(parent, children);
}

function capture(path: string, inputs: Map<string, string>): void {
  if (inputs.has(path)) return;
  inputs.set(path, readFileSync(path, 'utf8'));
  const children = knownChildren.get(path);
  children?.forEach((child) => capture(child, inputs));
}

/**
Observe the actual loader, including imports executed by a config factory.
*/
export async function observeConfigLoad<T>(
  path: string,
  load: () => Promise<T>,
): Promise<{ value: T; inputs: ReadonlyMap<string, string> }> {
  const inputs = new Map<string, string>();
  capture(normalizeAbsolutePath(path), inputs);
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      const parent = physicalPath(context.parentURL);
      if (parent !== undefined && inputs.has(parent))
        recordChild(parent, result.url, inputs);
      return result;
    },
  });
  try {
    return { value: await load(), inputs };
  } finally {
    hook.deregister();
  }
}

function recordChild(
  parent: string,
  url: string,
  inputs: Map<string, string>,
): void {
  const child = physicalPath(url);
  if (child === undefined) return;
  addChild(parent, child);
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
