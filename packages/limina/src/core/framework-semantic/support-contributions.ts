import type ts from 'typescript';
import { decideReferenceRequirement } from '../dependency-semantics';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import { isTypeScriptSemanticSource } from '../project-dependencies/source-evidence';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import { isDependencyContributionInput } from '../typescript-semantic/contribution-inputs';
import { observeProjectReferenceRedirect } from '../typescript-semantic/reference-redirect';
import { requestEligibility } from '../typescript-semantic/request-eligibility';
import type {
  FrameworkSemanticKind,
  PreparedDependencyFact,
} from './contracts';
import {
  enumerateGeneratedSemanticDependencies,
  type GeneratedSemanticDependency,
} from './generated-dependencies';
import {
  createPreparedFact,
  type ResolvedFrameworkCandidate,
} from './prepared-type-evidence';

interface SupportOptions {
  boundary: WorkspaceSourceBoundary;
  checkerName: string;
  framework: FrameworkSemanticKind;
  identity: string;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  program: ts.Program;
  rootNames: readonly string[];
  tsModule: typeof ts;
  resolutionHost: ts.ModuleResolutionHost;
  resolve(
    candidate: ResolvedFrameworkCandidate['candidate'],
  ): Omit<ResolvedFrameworkCandidate, 'candidate'>;
}

function isSupportFile(options: SupportOptions, file: ts.SourceFile): boolean {
  return [
    !options.rootNames.includes(file.fileName),
    isTypeScriptSemanticSource(file.fileName),
    // Generated files need their adapter's source mapping, never a guessed owner.
    options.tsModule.sys.fileExists(file.fileName),
    isDependencyContributionInput(
      {
        configPath: '',
        fileNames: options.rootNames,
        options: options.program.getCompilerOptions(),
        workspaceSourceBoundary: options.boundary,
      },
      file.fileName,
    ),
  ].every(Boolean);
}

function sourceModuleFact(
  options: SupportOptions,
  dependency: GeneratedSemanticDependency,
): PreparedDependencyFact | undefined {
  if (dependency.literal === null) return undefined;
  const candidate: ResolvedFrameworkCandidate['candidate'] = {
    containingSourceFile: dependency.sourceFile,
    literal: dependency.literal,
    framework: options.framework,
    identityId: options.identity,
    provenance: 'direct-source',
    semanticSpecifier: dependency.record.specifier,
    sourceRecord: dependency.record,
  };
  const resolved = { candidate, ...options.resolve(candidate) };
  return hasSourceTarget(resolved.target)
    ? createPreparedFact({
        ...options,
        managedOutputLookup: options.managedOutputLookup,
        resolved,
      })
    : undefined;
}

function hasSourceTarget(
  target: ResolvedFrameworkCandidate['target'],
): boolean {
  return target !== null && !isDeclarationFile(target.resolvedFileName);
}

function directiveTarget(
  options: SupportOptions,
  dependency: GeneratedSemanticDependency,
): string | undefined {
  const record = dependency.record;
  if (record.kind === 'triple-slash-path')
    return options.tsModule.resolveTripleslashReference(
      record.specifier,
      record.filePath,
    );
  return record.kind === 'triple-slash-types'
    ? resolveTypeDirective(options, dependency)
    : undefined;
}
function directiveMode(
  dependency: GeneratedSemanticDependency,
): ts.ResolutionMode {
  const directive = dependency.sourceFile.typeReferenceDirectives.find(
    (item) => item.fileName === dependency.record.specifier,
  );
  return directive?.resolutionMode ?? dependency.sourceFile.impliedNodeFormat;
}
function resolveTypeDirective(
  options: SupportOptions,
  dependency: GeneratedSemanticDependency,
): string | undefined {
  const record = dependency.record;
  return options.tsModule.resolveTypeReferenceDirective(
    record.specifier,
    record.filePath,
    options.program.getCompilerOptions(),
    options.resolutionHost,
    undefined,
    undefined,
    directiveMode(dependency),
  ).resolvedTypeReferenceDirective?.resolvedFileName;
}
function compilerInputFact(
  options: SupportOptions,
  dependency: GeneratedSemanticDependency,
): PreparedDependencyFact | undefined {
  const target = directiveTarget(options, dependency);
  if (!isImplementationInput(options, target)) return undefined;
  return {
    framework: options.framework,
    provenance: 'direct-source',
    importRecord: dependency.record,
    semanticSpecifier: dependency.record.specifier,
    resolutionMode: String(dependency.sourceFile.impliedNodeFormat),
    target: {
      resolvedFileName: target!,
      isExternalLibraryImport: false,
      resolvedBy: 'typescript',
    },
    redirect: observeProjectReferenceRedirect(
      options.program,
      target!,
      options.tsModule,
    ),
  };
}

function contributionFact(
  options: SupportOptions,
  dependency: GeneratedSemanticDependency,
): PreparedDependencyFact | undefined {
  const fact =
    dependency.literal === null
      ? compilerInputFact(options, dependency)
      : sourceModuleFact(options, dependency);
  return fact === undefined ? undefined : requiredContribution(fact);
}

/**
Collect from the adapter's existing Program; never widen roots or own foreign implementations.
*/
export function collectFrameworkSupportContributions(
  options: SupportOptions,
): PreparedDependencyFact[] {
  return options.program
    .getSourceFiles()
    .filter((file) => isSupportFile(options, file))
    .flatMap((file) => collectSupportFile(options, file));
}
function collectSupportFile(
  options: SupportOptions,
  file: ts.SourceFile,
): PreparedDependencyFact[] {
  return enumerateGeneratedSemanticDependencies({
    generatedFilePath: file.fileName,
    sourceFile: file,
    tsModule: options.tsModule,
  })
    .filter(
      (dependency) =>
        requestEligibility(file, dependency.record, options.tsModule)
          .governance,
    )
    .flatMap((dependency) => contributionFact(options, dependency) ?? []);
}
function isNeededContribution(
  decision: ReturnType<typeof decideReferenceRequirement>,
): boolean {
  return decision.state === 'pending' || decision.value !== null;
}

function requiredContribution(
  fact: PreparedDependencyFact,
): PreparedDependencyFact | undefined {
  return isNeededContribution(decideReferenceRequirement(fact))
    ? fact
    : undefined;
}

function isImplementationInput(
  options: SupportOptions,
  target: string | undefined,
): boolean {
  return (
    target !== undefined &&
    [
      !isDeclarationFile(target),
      options.resolutionHost.fileExists(target),
    ].every(Boolean)
  );
}
