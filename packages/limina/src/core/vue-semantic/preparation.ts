import type {
  ResolvedCheckerModuleName,
  VueProjectSemanticIdentity,
} from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { FrameworkSemanticDependencyPreparation } from '../framework-semantic/contracts';
import {
  mergePreparedDirectSourceRecords,
  prepareResolvedFrameworkCandidates,
} from '../framework-semantic/prepared-dependency';
import type { ImportRecord } from '../import-analysis/records';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import type { VueSemanticContext } from './context';
import { getVueServiceScript } from './dependency';
import { collectVueMappedCandidates, type VueCandidate } from './projection';

interface ResolvedVueCandidate {
  candidate: VueCandidate;
  resolutionMode: string;
  target: ResolvedCheckerModuleName | null;
}

function createFailure(
  reason: string,
  stage: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'unsupported' }
  >['stage'],
): Extract<FrameworkSemanticDependencyPreparation, { kind: 'unsupported' }> {
  return { kind: 'unsupported', reason, stage };
}

function getSnapshotText(snapshot: ts.IScriptSnapshot | undefined): string {
  if (snapshot === undefined) {
    throw new Error('Vue source script does not expose its source snapshot.');
  }
  return snapshot.getText(0, snapshot.getLength());
}

function isCheckerSource(options: {
  fileName: string;
  identity: VueProjectSemanticIdentity;
}): boolean {
  return options.identity.profilesByFileName.has(
    normalizeAbsolutePath(options.fileName),
  );
}

function createTarget(options: {
  context: VueSemanticContext;
  resolvedModule: ts.ResolvedModuleFull | undefined;
}): ResolvedCheckerModuleName | null {
  if (options.resolvedModule === undefined) return null;
  const resolvedFileName = normalizeAbsolutePath(
    options.resolvedModule.resolvedFileName,
  );
  return {
    isExternalLibraryImport:
      options.resolvedModule.isExternalLibraryImport === true,
    resolvedBy: isCheckerSource({
      fileName: resolvedFileName,
      identity: options.context.identity,
    })
      ? 'checker-source'
      : 'typescript',
    resolvedFileName,
  };
}

function getResolutionMode(options: {
  candidate: VueCandidate;
  context: VueSemanticContext;
}): string {
  const api = options.context.tsModule as typeof ts & {
    getModeForUsageLocation?: (
      sourceFile: ts.SourceFile,
      literal: ts.StringLiteralLike,
      compilerOptions: ts.CompilerOptions,
    ) => unknown;
  };
  return api.getModeForUsageLocation === undefined
    ? 'default'
    : String(
        api.getModeForUsageLocation(
          options.candidate.containingSourceFile,
          options.candidate.literal,
          options.context.identity.options,
        ),
      );
}

function resolveCandidates(options: {
  candidates: readonly VueCandidate[];
  context: VueSemanticContext;
}): ResolvedVueCandidate[] {
  const byLiteral = options.context.resolveModuleNameLiterals(
    options.candidates.map((candidate) => candidate.literal),
  );
  return options.candidates.map((candidate) => ({
    candidate,
    resolutionMode: getResolutionMode({ candidate, context: options.context }),
    target: createTarget({
      context: options.context,
      resolvedModule: byLiteral.get(candidate.literal)?.resolvedModule,
    }),
  }));
}

function getEvidenceProgram(
  context: VueSemanticContext,
  resolved: readonly ResolvedVueCandidate[],
): ts.Program | undefined {
  return resolved.some((item) => item.target === null)
    ? context.program
    : undefined;
}

function prepareMappedCandidates(options: {
  candidates: readonly VueCandidate[];
  context: VueSemanticContext;
  directSourceRecords: ImportRecord[];
  managedOutputLookup?: ManagedOutputDeclarationLookup;
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): FrameworkSemanticDependencyPreparation {
  const direct = mergePreparedDirectSourceRecords(options.directSourceRecords);
  if (direct.kind === 'unsupported') return direct;
  const resolved = resolveCandidates(options);
  const prepared = prepareResolvedFrameworkCandidates({
    checkerName: 'vue-tsc',
    framework: 'vue',
    managedOutputLookup: options.managedOutputLookup,
    program: getEvidenceProgram(options.context, resolved),
    resolved,
    tsModule: options.context.tsModule,
  });
  if (prepared.kind === 'unsupported') return prepared;
  return {
    directSourceRecords: direct.records,
    facts: prepared.facts,
    kind: 'supported',
    unmapped: options.unmapped,
  };
}

function getMaterializedService(options: {
  context: VueSemanticContext;
  filePath: string;
}) {
  const filePath = normalizeAbsolutePath(options.filePath);
  const service = getVueServiceScript({
    context: options.context,
    fileName: filePath,
  });
  if (service === null) return null;
  const sourceFile = options.context.getSemanticSourceFile(filePath);
  if (sourceFile === undefined) return null;
  return { filePath, service, sourceFile };
}

function prepareUnchecked(options: {
  context: VueSemanticContext;
  filePath: string;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
}): FrameworkSemanticDependencyPreparation {
  const materialized = getMaterializedService(options);
  if (materialized === null) {
    return createFailure(
      'Vue semantic context did not materialize a TypeScript service script for the framework source.',
      'service-script-materialization',
    );
  }
  const { filePath, service, sourceFile } = materialized;
  const sourceText = getSnapshotText(service.sourceScript.snapshot);
  const directSourceRecords: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['directSourceRecords'] = [];
  const unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'] = [];
  const projected = collectVueMappedCandidates({
    context: options.context,
    directSourceRecords,
    filePath,
    service,
    sourceFile,
    sourceText,
    unmapped,
  });
  if (projected.kind === 'unsupported') return projected;
  return prepareMappedCandidates({
    candidates: projected.candidates,
    context: options.context,
    directSourceRecords,
    managedOutputLookup: options.managedOutputLookup,
    unmapped,
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function prepareVueSemanticDependencies(options: {
  context: VueSemanticContext;
  filePath: string;
  managedOutputLookup?: ManagedOutputDeclarationLookup;
}): FrameworkSemanticDependencyPreparation {
  try {
    options.context.assertActive();
    return prepareUnchecked(options);
  } catch (error) {
    return createFailure(
      `Vue semantic service-script preparation failed: ${formatError(error)}`,
      'service-script-materialization',
    );
  }
}
