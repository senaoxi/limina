import type ts from 'typescript';
import { decideReferenceRequirement } from '../dependency-semantics';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import { isTypeScriptSemanticSource } from '../project-dependencies/source-evidence';
import type { WorkspaceSourceBoundary } from '../typescript-semantic';
import { isDependencyContributionInput } from '../typescript-semantic/contribution-inputs';
import {
  type DeclarationClosure,
  projectDeclarationClosure,
} from '../typescript-semantic/declaration-closure';
import { createImportRecordIdentity } from '../typescript-semantic/import-record';
import { observeProjectReferenceRedirect } from '../typescript-semantic/reference-redirect';
import { requestEligibility } from '../typescript-semantic/request-eligibility';
import {
  getResolutionOrigin,
  resolveTypeWithOrigin,
} from '../typescript-semantic/resolution-origin';
import {
  collectFrameworkEnvironmentEntries,
  collectTypeEnvironmentEntries,
} from '../typescript-semantic/type-environment-entries';
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
  configPath: string;
  entryFacts: readonly PreparedDependencyFact[];
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
  return createPreparedFact({
    ...options,
    resolved,
    managedOutputLookup: options.managedOutputLookup,
  });
}

function directiveTarget(
  options: SupportOptions,
  dependency: GeneratedSemanticDependency,
): PreparedDependencyFact['target'] {
  const record = dependency.record;
  if (record.kind === 'triple-slash-path')
    return pathTarget(options, dependency);
  return record.kind === 'triple-slash-types'
    ? typeTarget(options, dependency)
    : null;
}
function typeTarget(
  options: SupportOptions,
  dependency: GeneratedSemanticDependency,
): PreparedDependencyFact['target'] {
  const record = dependency.record;
  const target = resolveTypeWithOrigin(
    options.tsModule,
    record.specifier,
    record.filePath,
    options.program.getCompilerOptions(),
    options.resolutionHost,
    undefined,
    undefined,
    directiveMode(dependency),
  ).resolvedTypeReferenceDirective;
  return target?.resolvedFileName
    ? {
        resolvedFileName: target.resolvedFileName,
        resolvedBy: 'typescript',
        isExternalLibraryImport: target.isExternalLibraryImport === true,
        resolutionOrigin: getResolutionOrigin(target),
      }
    : null;
}
function pathTarget(
  options: SupportOptions,
  dependency: GeneratedSemanticDependency,
): PreparedDependencyFact['target'] {
  const record = dependency.record;
  const target = options.tsModule.resolveTripleslashReference(
    record.specifier,
    record.filePath,
  );
  return options.resolutionHost.fileExists(target)
    ? {
        resolvedFileName: target,
        resolvedBy: 'typescript',
        isExternalLibraryImport: false,
        resolutionOrigin: {
          version: 1,
          compiler: options.tsModule.version,
          route: 'local',
          target,
        },
      }
    : null;
}
function directiveMode(
  dependency: GeneratedSemanticDependency,
): ts.ResolutionMode {
  const directive = dependency.sourceFile.typeReferenceDirectives.find(
    (item) => item.fileName === dependency.record.specifier,
  );
  return directive?.resolutionMode ?? dependency.sourceFile.impliedNodeFormat;
}
function compilerInputFact(
  options: SupportOptions,
  dependency: GeneratedSemanticDependency,
): PreparedDependencyFact | undefined {
  const target = directiveTarget(options, dependency);
  if (
    !['triple-slash-path', 'triple-slash-types'].includes(
      dependency.record.kind,
    )
  )
    return undefined;
  return {
    framework: options.framework,
    provenance: 'direct-source',
    importRecord: dependency.record,
    semanticSpecifier: dependency.record.specifier,
    resolutionMode: String(dependency.sourceFile.impliedNodeFormat),
    target,
    redirect:
      target === null
        ? undefined
        : observeProjectReferenceRedirect(
            options.program,
            target.resolvedFileName,
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
  return fact === undefined
    ? undefined
    : {
        ...fact,
        eligibility: requestEligibility(
          dependency.sourceFile,
          dependency.record,
          options.tsModule,
        ),
      };
}

function hasSupportFile(
  options: SupportOptions,
  source: ts.SourceFile | undefined,
): source is ts.SourceFile {
  return source !== undefined && isSupportFile(options, source);
}
// Project physical support through the shared policy.
export function collectFrameworkSupportContributions(options: SupportOptions): {
  closure: DeclarationClosure;
  facts: PreparedDependencyFact[];
} {
  const byFile = Map.groupBy(
    options.entryFacts,
    (fact) => fact.importRecord.filePath,
  );
  const entryFiles = new Set(byFile.keys());
  const lookup = (file: string): PreparedDependencyFact[] => {
    const cached = byFile.get(file);
    if (cached) return cached;
    const source = options.program.getSourceFile(file);
    const facts = hasSupportFile(options, source)
      ? enumerateGeneratedSemanticDependencies({
          generatedFilePath: file,
          sourceFile: source,
          tsModule: options.tsModule,
        }).flatMap((dependency) => contributionFact(options, dependency) ?? [])
      : [];
    byFile.set(file, facts);
    return facts;
  };
  const closure = projectDeclarationClosure({
    configPath: options.configPath,
    entries: [
      ...[...entryFiles].map((fileName) => ({
        kind: 'root' as const,
        fileName,
      })),
      ...collectFrameworkEnvironmentEntries({
        compiler: options.tsModule,
        host: options.resolutionHost,
        rootNames: options.rootNames,
        scriptNames: options.program.getRootFileNames(),
      }),
      ...collectTypeEnvironmentEntries({
        compiler: options.tsModule,
        options: options.program.getCompilerOptions(),
        host: options.resolutionHost,
        configPath: options.configPath,
      }),
    ],
    noResolve: options.program.getCompilerOptions().noResolve,
    boundary: options.boundary,
    managedOutputLookup: options.managedOutputLookup,
    records: (file) =>
      [
        entryFiles.has(file),
        options.program.getSourceFile(file) !== undefined,
      ].some(Boolean)
        ? lookup(file).map((fact) => fact.importRecord)
        : undefined,
    fact: (record) => {
      const fact = lookup(record.filePath).find(
        (item) =>
          createImportRecordIdentity(item.importRecord) ===
          createImportRecordIdentity(record),
      )!;
      const decision = decideReferenceRequirement(fact);
      return {
        ...fact,
        referenceRequirement:
          decision.state === 'decided' ? decision.value : null,
      };
    },
  });
  return {
    closure,
    facts: closure.records
      .filter((record) => !entryFiles.has(record.filePath))
      .map(
        (record) =>
          lookup(record.filePath).find(
            (fact) =>
              createImportRecordIdentity(fact.importRecord) ===
              createImportRecordIdentity(record),
          )!,
      ),
  };
}
