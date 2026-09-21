import {
  getBuildCheckerSupportedExtensions,
  isNativeTypeScriptProjectInput,
  type ResolvedCheckerModuleName,
} from '#checkers';
import { resolveExistingFilePath } from '#utils/module-resolution';
import {
  getPlainSpecifierExtension,
  hasModuleSpecifierQueryOrFragment,
  isBarePackageSpecifier,
  isPackageImportSpecifier,
} from '#utils/module-specifier';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import type ts from 'typescript';
import type {
  ClassifyImportRuntimeEvidenceOptions,
  ImportModuleClassification,
  ImportRuntimeResolutionEvidence,
  RuntimeEvidence,
} from './evidence';
import { isKnownFrameworkVirtualSpecifier } from './virtual-modules';

// The complete specifier is the runtime identity. Limina does not split a
// query or fragment off a specifier: a module host owns that meaning.
interface RuntimeClassificationContext {
  checkedPath: string | undefined;
  compilerOptions: ts.CompilerOptions;
  extensions: readonly string[];
  oxcResolvedFilePath: string | null;
  runtimeFilePath: string | null;
  specifier: string;
}

function isJsonModulePath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.json');
}

function isOrdinaryTypeScriptModulePath(
  filePath: string,
  compilerOptions: ts.CompilerOptions,
): boolean {
  return isJsonModulePath(filePath)
    ? compilerOptions.resolveJsonModule === true
    : isNativeTypeScriptProjectInput(filePath);
}

function hasSupportedCheckerSourceExtension(
  filePath: string,
  extensions: readonly string[],
): boolean {
  const normalizedFilePath = filePath.toLowerCase();

  return extensions.some((extension) =>
    normalizedFilePath.endsWith(extension.toLowerCase()),
  );
}
function isKnownCheckerSourcePath(filePath: string): boolean {
  return (
    filePath.toLowerCase().endsWith('.astro') ||
    filePath.toLowerCase().endsWith('.svelte') ||
    hasSupportedCheckerSourceExtension(
      filePath,
      getBuildCheckerSupportedExtensions('vue-tsc'),
    )
  );
}

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || path.isAbsolute(specifier);
}

function resolveRelativeRuntimeFile(options: {
  containingFile: string;
  specifier: string;
}): { checkedPath?: string; filePath?: string } {
  if (!isRelativeOrAbsoluteSpecifier(options.specifier)) {
    return {};
  }

  const checkedPath = normalizeAbsolutePath(
    path.resolve(path.dirname(options.containingFile), options.specifier),
  );
  const filePath = resolveExistingFilePath(checkedPath);

  return filePath === null ? { checkedPath } : { checkedPath, filePath };
}

function getBarePackageSubpath(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.slice(2).join('/')
    : segments.slice(1).join('/');
}

function getExtensionTarget(specifier: string): string {
  if (isBarePackageSpecifier(specifier)) {
    return getBarePackageSubpath(specifier);
  }

  if (isPackageImportSpecifier(specifier)) {
    return specifier.slice(1);
  }

  return specifier;
}

function isExplicitPathExtension(specifier: string): boolean {
  return getPlainSpecifierExtension(getExtensionTarget(specifier)) !== null;
}
function classifyCheckerSourceResolution(
  resolution: ResolvedCheckerModuleName | null,
): ImportRuntimeResolutionEvidence | undefined {
  if (resolution?.resolvedBy !== 'checker-source') {
    return undefined;
  }

  return {
    classification: 'checker-source',
    runtime: {
      authority: 'filesystem',
      filePath: resolution.resolvedFileName,
      kind: 'file',
    },
  };
}

function classifyUnsupportedVirtualSpecifier(
  specifier: string,
): ImportRuntimeResolutionEvidence | undefined {
  if (!isKnownFrameworkVirtualSpecifier(specifier)) {
    return undefined;
  }

  return {
    classification: 'resource',
    runtime: {
      kind: 'unsupported',
      reason:
        'Virtual and framework-injected runtime modules require an explicit bundler authority that Limina does not model yet.',
    },
  };
}

function classifyUninterpretedSpecifier(
  specifier: string,
): ImportRuntimeResolutionEvidence | undefined {
  if (!hasModuleSpecifierQueryOrFragment(specifier)) return undefined;
  // Even resolving the complete string as a path would assign host meaning:
  // path.resolve('./file?x/../style.css') silently recovers './style.css'.
  return {
    classification: 'ordinary-module',
    runtime: {
      kind: 'unsupported',
      reason:
        'Runtime interpretation of query or fragment specifiers requires an explicit host authority that Limina does not model.',
    },
  };
}

function firstEvidence(
  values: readonly (ImportRuntimeResolutionEvidence | undefined)[],
): ImportRuntimeResolutionEvidence | undefined {
  return values.find((value) => value !== undefined);
}
function createRuntimeContext(
  options: ClassifyImportRuntimeEvidenceOptions,
): RuntimeClassificationContext {
  const relativeRuntime = resolveRelativeRuntimeFile({
    containingFile: options.containingFile,
    specifier: options.specifier,
  });
  const runtimeFilePath =
    options.oxcResolvedFilePath === null
      ? (relativeRuntime.filePath ?? null)
      : options.oxcResolvedFilePath;

  return {
    checkedPath: relativeRuntime.checkedPath,
    compilerOptions: options.compilerOptions,
    extensions: options.extensions,
    oxcResolvedFilePath: options.oxcResolvedFilePath,
    runtimeFilePath,
    specifier: options.specifier,
  };
}

function isCheckerSourcePath(
  filePath: string,
  extensions: readonly string[],
): boolean {
  return (
    hasSupportedCheckerSourceExtension(filePath, extensions) ||
    isKnownCheckerSourcePath(filePath)
  );
}

function isExplicitNonSourceExtension(
  context: RuntimeClassificationContext,
): boolean {
  return [
    isExplicitPathExtension(context.specifier),
    !isOrdinaryTypeScriptModulePath(context.specifier, context.compilerOptions),
    !hasSupportedCheckerSourceExtension(context.specifier, context.extensions),
    !isKnownCheckerSourcePath(context.specifier),
  ].every(Boolean);
}

function isResolvedResource(
  context: RuntimeClassificationContext,
  runtimeIsOrdinary: boolean,
  runtimeIsCheckerSource: boolean,
): boolean {
  return (
    context.runtimeFilePath !== null &&
    !runtimeIsOrdinary &&
    !runtimeIsCheckerSource
  );
}

function isMissingResource(
  context: RuntimeClassificationContext,
  explicitNonSourceExtension: boolean,
): boolean {
  return context.runtimeFilePath === null && explicitNonSourceExtension;
}

function classifyRuntimeModule(
  context: RuntimeClassificationContext,
): ImportModuleClassification {
  const runtimeCandidatePath =
    context.runtimeFilePath === null
      ? context.specifier
      : context.runtimeFilePath;
  const runtimeIsOrdinary = isOrdinaryTypeScriptModulePath(
    runtimeCandidatePath,
    context.compilerOptions,
  );
  const runtimeIsCheckerSource = isCheckerSourcePath(
    runtimeCandidatePath,
    context.extensions,
  );
  const resource = [
    isResolvedResource(context, runtimeIsOrdinary, runtimeIsCheckerSource),
    isMissingResource(context, isExplicitNonSourceExtension(context)),
  ].some(Boolean);

  return resource ? 'resource' : 'ordinary-module';
}
function resolveRuntimeAuthority(
  oxcResolvedFilePath: string | null,
): 'filesystem' | 'oxc' {
  return oxcResolvedFilePath === null ? 'filesystem' : 'oxc';
}

function createRuntimeEvidence(
  context: RuntimeClassificationContext,
): RuntimeEvidence {
  return context.runtimeFilePath === null
    ? { checkedPath: context.checkedPath, kind: 'missing' }
    : {
        authority: resolveRuntimeAuthority(context.oxcResolvedFilePath),
        filePath: context.runtimeFilePath,
        kind: 'file',
      };
}

export function classifyImportRuntimeEvidence(
  options: ClassifyImportRuntimeEvidenceOptions,
): ImportRuntimeResolutionEvidence {
  const earlyEvidence = firstEvidence([
    classifyCheckerSourceResolution(options.typeScriptResolution),
    classifyUninterpretedSpecifier(options.specifier),
    classifyUnsupportedVirtualSpecifier(options.specifier),
  ]);

  if (earlyEvidence) {
    return earlyEvidence;
  }

  const context = createRuntimeContext(options);

  return {
    classification: classifyRuntimeModule(context),
    runtime: createRuntimeEvidence(context),
  };
}
