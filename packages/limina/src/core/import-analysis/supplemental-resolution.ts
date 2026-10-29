import { hasModuleSpecifierQueryOrFragment } from '#utils/module-specifier';
import { normalizeAbsolutePath } from '#utils/path';
import { createRequire } from 'node:module';
import { ResolverFactory } from 'oxc-resolver';
import ts from 'typescript';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import {
  createResolverOptions,
  hasTypeScriptOnlyResolutionOptions,
} from './resolver-profile';

const resolverVersion = (
  createRequire(import.meta.url)('oxc-resolver/package.json') as {
    version: string;
  }
).version;

export interface SupplementalResolutionRequest {
  requestId: string;
  contextId: string;
  importer: string;
  specifier: string;
  mode: ts.ResolutionMode;
  options: ts.CompilerOptions;
  configPath: string;
  extensions: string[];
}
export type SupplementalResolution = {
  readonly requestId: string;
  readonly contextId: string;
  readonly profile: string;
  readonly resolver: string;
} & (
  | { readonly state: 'resolved'; readonly target: string }
  | {
      readonly state: 'unresolved' | 'unsupported' | 'unavailable' | 'failed';
      readonly reason: string;
    }
);

/** Fresh factories deliberately do not retain positive or negative lookups across
 * collections. A physical result is not a compiler resolution or load grant. */
export function discoverSupplementalTarget(
  input: SupplementalResolutionRequest,
): SupplementalResolution {
  const api = ts as typeof ts & {
    getConditions?: (
      options: ts.CompilerOptions,
      mode: ts.ResolutionMode,
    ) => string[];
  };
  const conditions = api.getConditions?.(input.options, input.mode);
  const profile = nativeFingerprint([input, conditions, resolverVersion]);
  const base = {
    requestId: input.requestId,
    contextId: input.contextId,
    profile,
    resolver: `oxc-resolver@${resolverVersion}`,
  };
  if (hasModuleSpecifierQueryOrFragment(input.specifier))
    return { ...base, state: 'unsupported', reason: 'module-host-suffix' };
  if (
    conditions === undefined ||
    hasTypeScriptOnlyResolutionOptions(input.options)
  )
    return {
      ...base,
      state: 'unsupported',
      reason: 'request-resolution-profile-unavailable',
    };
  try {
    const resolver = new ResolverFactory({
      ...createResolverOptions({
        compilerOptions: input.options,
        configPath: input.configPath,
        extensions: input.extensions,
      }),
      conditionNames: conditions,
    });
    const result = resolver.resolveFileSync(input.importer, input.specifier);
    if (result.path !== undefined)
      return {
        ...base,
        state: 'resolved',
        target: normalizeAbsolutePath(result.path),
      };
    // The binding exposes errors as text, not typed lookup failures. Do not
    // claim a completed miss from an arbitrary resolver error.
    return {
      ...base,
      state:
        result.error === undefined ||
        result.error === `Cannot find module '${input.specifier}'`
          ? 'unresolved'
          : 'unavailable',
      reason: result.error ?? 'no-physical-target',
    };
  } catch (error) {
    return {
      ...base,
      state: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
