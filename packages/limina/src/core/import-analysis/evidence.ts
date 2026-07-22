import {
  getBuildCheckerSupportedExtensions,
  isNativeTypeScriptProjectInput,
  type ResolvedCheckerModuleName,
} from '#checkers';
import { resolveExistingFilePath } from '#utils/module-resolution';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'node:path';
import type ts from 'typescript';
import type { TypeEvidence } from '../type-evidence/cache';

export type ImportModuleClassification =
  | 'checker-source'
  | 'resource'
  | 'ordinary-module';

export type RuntimeEvidence =
  | {
      authority: 'filesystem' | 'oxc' | 'package-export';
      baseOnly?: boolean;
      filePath: string;
      kind: 'file';
    }
  | {
      assertionId: string;
      kind: 'asserted-virtual';
    }
  | {
      checkedPath?: string;
      kind: 'missing';
    }
  | {
      kind: 'unsupported';
      reason: string;
    };

export interface ImportRuntimeResolutionEvidence {
  classification: ImportModuleClassification;
  runtime: RuntimeEvidence;
}

export interface ImportResolutionEvidence
  extends ImportRuntimeResolutionEvidence {
  type: TypeEvidence;
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
  if (isJsonModulePath(filePath)) {
    return compilerOptions.resolveJsonModule === true;
  }

  return isNativeTypeScriptProjectInput(filePath);
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

function resolveRelativeRuntimeFile(options: {
  baseSpecifier: string;
  containingFile: string;
}): { checkedPath?: string; filePath?: string } {
  if (
    !options.baseSpecifier.startsWith('.') &&
    !path.isAbsolute(options.baseSpecifier)
  ) {
    return {};
  }

  const checkedPath = normalizeAbsolutePath(
    path.resolve(path.dirname(options.containingFile), options.baseSpecifier),
  );
  const filePath = resolveExistingFilePath(checkedPath);

  return filePath ? { checkedPath, filePath } : { checkedPath };
}

function isExplicitPathExtension(specifier: string): boolean {
  return path.extname(specifier).length > 0;
}

function isKnownUnsupportedVirtualSpecifier(specifier: string): boolean {
  return specifier.startsWith('\0') || specifier.startsWith('virtual:');
}

export function classifyImportRuntimeEvidence(options: {
  compilerOptions: ts.CompilerOptions;
  containingFile: string;
  extensions: readonly string[];
  oxcResolvedFilePath: string | null;
  specifier: string;
  typeScriptResolution: ResolvedCheckerModuleName | null;
}): ImportRuntimeResolutionEvidence {
  const { baseSpecifier, hasQuery } = splitSpecifierQuery(options.specifier);

  if (options.typeScriptResolution?.resolvedBy === 'checker-source') {
    return {
      classification: 'checker-source',
      runtime: {
        authority: 'filesystem',
        filePath: options.typeScriptResolution.resolvedFileName,
        kind: 'file',
      },
    };
  }

  if (isKnownUnsupportedVirtualSpecifier(options.specifier)) {
    return {
      classification: 'resource',
      runtime: {
        kind: 'unsupported',
        reason:
          'Virtual and framework-injected runtime modules require an explicit bundler authority that Limina does not model yet.',
      },
    };
  }

  const relativeRuntime = resolveRelativeRuntimeFile({
    baseSpecifier,
    containingFile: options.containingFile,
  });
  const runtimeFilePath =
    options.oxcResolvedFilePath ?? relativeRuntime.filePath ?? null;
  const runtimeCandidatePath = runtimeFilePath ?? baseSpecifier;
  const runtimeIsOrdinary = isOrdinaryTypeScriptModulePath(
    runtimeCandidatePath,
    options.compilerOptions,
  );
  const runtimeIsCheckerSource =
    hasSupportedCheckerSourceExtension(
      runtimeCandidatePath,
      options.extensions,
    ) || isKnownCheckerSourcePath(runtimeCandidatePath);
  const explicitNonSourceExtension =
    isExplicitPathExtension(baseSpecifier) &&
    !isOrdinaryTypeScriptModulePath(baseSpecifier, options.compilerOptions) &&
    !hasSupportedCheckerSourceExtension(baseSpecifier, options.extensions) &&
    !isKnownCheckerSourcePath(baseSpecifier);
  const isResource =
    hasQuery ||
    (runtimeFilePath !== null &&
      !runtimeIsOrdinary &&
      !runtimeIsCheckerSource) ||
    (runtimeFilePath === null && explicitNonSourceExtension);

  if (!isResource) {
    return {
      classification: 'ordinary-module',
      runtime: runtimeFilePath
        ? {
            authority: options.oxcResolvedFilePath ? 'oxc' : 'filesystem',
            filePath: runtimeFilePath,
            kind: 'file',
          }
        : {
            checkedPath: relativeRuntime.checkedPath,
            kind: 'missing',
          },
    };
  }

  return {
    classification: 'resource',
    runtime: runtimeFilePath
      ? {
          authority: options.oxcResolvedFilePath ? 'oxc' : 'filesystem',
          baseOnly: hasQuery || undefined,
          filePath: runtimeFilePath,
          kind: 'file',
        }
      : {
          checkedPath: relativeRuntime.checkedPath,
          kind: 'missing',
        },
  };
}
