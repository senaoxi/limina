import type { CheckerPreset } from '#config/runner';
import type ts from 'typescript';
import { getCheckerAdapter } from './registry';
import type {
  CheckerModuleResolveOptions,
  CheckerProjectParseContext,
  ResolvedCheckerModuleName,
} from './types';
import { resolveTypeScriptModuleNameDetailed } from './typescript-resolution';

export {
  resolveTypeScriptModuleName,
  resolveTypeScriptModuleNameDetailed,
} from './typescript-resolution';

function getContextPresets(
  context: CheckerProjectParseContext,
): CheckerPreset[] {
  return context.checkerPresets.length === 0
    ? (['tsc'] satisfies CheckerPreset[])
    : context.checkerPresets;
}

function hasSupportedPreset(presets: readonly CheckerPreset[]): boolean {
  return presets.some((preset) => getCheckerAdapter(preset) !== null);
}

export function resolveModuleNameWithCheckersDetailed(options: {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  context: CheckerProjectParseContext;
  metrics?: CheckerModuleResolveOptions['metrics'];
  moduleResolutionCache?: ts.ModuleResolutionCache;
  specifier: string;
}): ResolvedCheckerModuleName | null {
  if (!hasSupportedPreset(getContextPresets(options.context))) return null;
  return resolveTypeScriptModuleNameDetailed({
    compilerOptions: options.compilerOptions,
    containingFile: options.containingFile,
    extensions: options.context.extensions,
    metrics: options.metrics,
    moduleResolutionCache: options.moduleResolutionCache,
    specifier: options.specifier,
  });
}

export function resolveModuleNameWithCheckers(options: {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  context: CheckerProjectParseContext;
  metrics?: CheckerModuleResolveOptions['metrics'];
  moduleResolutionCache?: ts.ModuleResolutionCache;
  specifier: string;
}): string | null {
  const resolved = resolveModuleNameWithCheckersDetailed(options);
  return resolved === null ? null : resolved.resolvedFileName;
}
