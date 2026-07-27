import {
  getBuildCheckerSupportedExtensions,
  isNativeTypeScriptProjectInput,
  type ResolvedCheckerModuleName,
} from '#checkers';
import { resolveExistingFilePath } from '#utils/module-resolution';
import {
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
interface RuntimeClassificationContext {
  baseSpecifier: string;
  checkedPath: string | undefined;
  compilerOptions: ts.CompilerOptions;
  extensions: readonly string[];
  hasQuery: boolean;
  oxcResolvedFilePath: string | null;
  runtimeFilePath: string | null;
}
function splitSpecifierQuery(specifier: string): {
  baseSpecifier: string;
  hasQuery: boolean;
} {
  const queryIndex = specifier.indexOf('?');

  return queryIndex === -1
    ? { baseSpecifier: specifier, hasQuery: false }
    : {
        baseSpecifier: specifier.slice(0, queryIndex),
        hasQuery: true,
      };
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
  return hasSupportedCheckerSourceExtension(
    filePath,
    getBuildCheckerSupportedExtensions('vue-tsc'),
  );
}

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') || path.isAbsolute(specifier);
}

function resolveRelativeRuntimeFile(options: {
  baseSpecifier: string;
  containingFile: string;
}): { checkedPath?: string; filePath?: string } {
  if (!isRelativeOrAbsoluteSpecifier(options.baseSpecifier)) {
    return {};
  }

  const checkedPath = normalizeAbsolutePath(
    path.resolve(path.dirname(options.containingFile), options.baseSpecifier),
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
  return path.extname(getExtensionTarget(specifier)).length > 0;
}
function isKnownUnsupportedVirtualSpecifier(specifier: string): boolean {
  return specifier.startsWith('\0') || specifier.startsWith('virtual:');
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
  if (!isKnownUnsupportedVirtualSpecifier(specifier)) {
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

function firstEvidence(
  values: readonly (ImportRuntimeResolutionEvidence | undefined)[],
): ImportRuntimeResolutionEvidence | undefined {
  return values.find((value) => value !== undefined);
}
function createRuntimeContext(
  options: ClassifyImportRuntimeEvidenceOptions,
): RuntimeClassificationContext {
  const { baseSpecifier, hasQuery } = splitSpecifierQuery(options.specifier);
  const relativeRuntime = resolveRelativeRuntimeFile({
    baseSpecifier,
    containingFile: options.containingFile,
  });
  const runtimeFilePath =
    options.oxcResolvedFilePath === null
      ? (relativeRuntime.filePath ?? null)
      : options.oxcResolvedFilePath;

  return {
    baseSpecifier,
    checkedPath: relativeRuntime.checkedPath,
    compilerOptions: options.compilerOptions,
    extensions: options.extensions,
    hasQuery,
    oxcResolvedFilePath: options.oxcResolvedFilePath,
    runtimeFilePath,
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
    isExplicitPathExtension(context.baseSpecifier),
    !isOrdinaryTypeScriptModulePath(
      context.baseSpecifier,
      context.compilerOptions,
    ),
    !hasSupportedCheckerSourceExtension(
      context.baseSpecifier,
      context.extensions,
    ),
    !isKnownCheckerSourcePath(context.baseSpecifier),
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
      ? context.baseSpecifier
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
    context.hasQuery,
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

function createFileRuntimeEvidence(
  context: RuntimeClassificationContext,
  classification: ImportModuleClassification,
): RuntimeEvidence {
  return {
    authority: resolveRuntimeAuthority(context.oxcResolvedFilePath),
    ...(classification === 'resource' && context.hasQuery
      ? { baseOnly: true }
      : {}),
    filePath: context.runtimeFilePath!,
    kind: 'file',
  };
}

function createRuntimeEvidence(
  context: RuntimeClassificationContext,
  classification: ImportModuleClassification,
): RuntimeEvidence {
  return context.runtimeFilePath === null
    ? { checkedPath: context.checkedPath, kind: 'missing' }
    : createFileRuntimeEvidence(context, classification);
}

export function classifyImportRuntimeEvidence(
  options: ClassifyImportRuntimeEvidenceOptions,
): ImportRuntimeResolutionEvidence {
  const earlyEvidence = firstEvidence([
    classifyCheckerSourceResolution(options.typeScriptResolution),
    classifyUnsupportedVirtualSpecifier(options.specifier),
  ]);

  if (earlyEvidence) {
    return earlyEvidence;
  }

  const context = createRuntimeContext(options);
  const classification = classifyRuntimeModule(context);

  return {
    classification,
    runtime: createRuntimeEvidence(context, classification),
  };
}
