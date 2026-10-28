import type {
  ResolvedCheckerModuleName,
  VueProjectSemanticIdentity,
} from '#checkers';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { CompilationObligationProof } from '../dependency-semantics';
import type { FrameworkSemanticDependencyPreparation } from '../framework-semantic/contracts';
import {
  mergePreparedDirectSourceRecords,
  prepareResolvedFrameworkCandidates,
} from '../framework-semantic/prepared-dependency';
import { requiresReferenceStructure } from '../framework-semantic/prepared-type-evidence';
import type { ImportRecord } from '../import-analysis/records';
import type { ManagedOutputDeclarationLookup } from '../import-graph/managed-output-provider';
import { getResolutionOrigin } from '../typescript-semantic/resolution-origin';
import { vueCompilationObligation } from './compilation-obligation';
import type { VueSemanticContext } from './context';
import { getVueServiceScript } from './dependency';
import { collectVueMappedCandidates, type VueCandidate } from './projection';

interface ResolvedVueCandidate {
  compilationObligation: CompilationObligationProof;
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
    resolutionOrigin: getResolutionOrigin(options.resolvedModule),
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

function resolveCandidates(options: {
  candidates: readonly VueCandidate[];
  context: VueSemanticContext;
}): ResolvedVueCandidate[] {
  return options.candidates.map((candidate) => {
    const requests = options.context.compilerRequests
      .collect(options.context.program, candidate.containingSourceFile)
      .filter((request) => request.literal === candidate.literal);
    return {
      candidate,
      compilationObligation: vueCompilationObligation(
        options.context,
        requests,
      ),
      resolutionMode: String(requests[0]?.mode),
      target: createTarget({
        context: options.context,
        resolvedModule: requests[0]?.raw?.resolvedModule,
      }),
    };
  });
}

function getStructuralProgram(
  context: VueSemanticContext,
  resolved: readonly ResolvedVueCandidate[],
): ts.Program | undefined {
  return resolved.some((item) => requiresReferenceStructure(item.target))
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
  if (
    resolved.some(
      (item) =>
        item.target === null && item.compilationObligation.state === 'unknown',
    )
  )
    return createFailure(
      'Vue compiler request has no qualified resolution observation.',
      'toolchain-compatibility',
    );
  const prepared = prepareResolvedFrameworkCandidates({
    checkerName: 'vue-tsc',
    framework: 'vue',
    managedOutputLookup: options.managedOutputLookup,
    getProgram: () => getStructuralProgram(options.context, resolved),
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
  const sourceFile = options.context.program.getSourceFile(filePath);
  return sourceFile === undefined ? null : { filePath, service, sourceFile };
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
