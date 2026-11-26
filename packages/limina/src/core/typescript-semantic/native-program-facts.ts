import type { ResolvedCheckerModuleName } from '#checkers';
import type ts from 'typescript';
import type {
  NativeEvidenceSnapshot,
  NativeResolution,
} from '../../domain/analysis/native-evidence';
import { summarizeCompilationObligation } from '../../domain/analysis/native-obligation';
import type { DeclarationReferenceRequirement } from '../dependency-semantics';
import type {
  TypeScriptSemanticChannel,
  TypeScriptSemanticResolution,
} from './contracts';
import type { NativeDependencyFact } from './dependency-fact';
import { createImportRecordIdentity } from './import-record';
import { nativeFingerprint } from './native-file-identity';
import type { NativeObservationAdapter } from './native-observation-adapter';
import type { NativeProgramFrontier } from './native-program-frontier';
import type { NativeRequestRecord } from './native-program-records';
import {
  type NativeReferenceObservation,
  observedDeclarationRedirect,
} from './reference-redirect';
import {
  getResolutionOrigin,
  type ResolutionOrigin,
} from './resolution-origin';

export function nativeProgramFacts(
  adapter: NativeObservationAdapter,
  entries: readonly NativeRequestRecord[],
): Map<string, NativeDependencyFact> {
  const modules = new Map(
    adapter.modules.map((item) => [item.requestId, item.raw?.resolvedModule]),
  );
  return projectNativeProgramFacts({
    snapshot: adapter.snapshot,
    frontier: adapter.frontier,
    references: adapter.references,
    entries,
    origin: (id) => {
      const raw = modules.get(id);
      return raw === undefined ? undefined : getResolutionOrigin(raw);
    },
  });
}

interface FactProjection {
  snapshot: NativeEvidenceSnapshot;
  frontier: NativeProgramFrontier;
  references: ReadonlyMap<string, NativeReferenceObservation>;
  entries: readonly NativeRequestRecord[];
  origin(id: string): ResolutionOrigin | undefined;
}

export function projectNativeProgramFacts(
  input: FactProjection,
): Map<string, NativeDependencyFact> {
  const resolutions = new Map(
    input.snapshot.resolutions.map((item) => [item.requestId, item]),
  );
  const obligations = new Map(
    input.snapshot.obligations.flatMap((item) =>
      item.requestIds.map((id) => [id, item] as const),
    ),
  );
  return new Map(
    input.entries.map((entry) => [
      createImportRecordIdentity(entry.record),
      nativeProgramFact({
        projection: input,
        entry,
        observed: resolutions.get(entry.request.id)!,
        obligation: obligations.get(entry.request.id) ?? null,
      }),
    ]),
  );
}

function nativeProgramFact(input: {
  projection: FactProjection;
  entry: NativeRequestRecord;
  observed: NativeResolution;
  obligation: NonNullable<NativeDependencyFact['nativeEvidence']>['obligation'];
}): NativeDependencyFact {
  const { projection, entry, observed, obligation } = input;
  const target = observed.target?.lexicalPath;
  const coverage = targetCoverage(projection, target);
  const resolution = nativeSemanticResolution(
    entry,
    observed,
    projection.origin(entry.request.id),
  );
  return {
    nativeEvidence: {
      requestId: entry.request.id,
      origin: entry.request.origin,
      obligation,
      coverage,
    },
    resolution,
    referenceRequirement: referenceRequirement(obligation, target),
    admission:
      observed.state === 'resolved' ? loadedAdmission(observed) : 'unresolved',
    redirect: targetRedirect(projection, target),
  };
}

function targetCoverage(
  projection: FactProjection,
  target: string | undefined,
) {
  return target === undefined
    ? null
    : projection.frontier.inspect(target).coverage;
}

function targetRedirect(
  projection: FactProjection,
  target: string | undefined,
) {
  return target === undefined
    ? undefined
    : observedDeclarationRedirect(projection.references.get(target));
}

function referenceRequirement(
  obligation: NonNullable<NativeDependencyFact['nativeEvidence']>['obligation'],
  target: string | undefined,
): DeclarationReferenceRequirement | null {
  if (target === undefined) return null;
  return isRequired(obligation)
    ? { kind: 'compiler-membership', targetFileName: target }
    : null;
}

function isRequired(
  obligation: NonNullable<NativeDependencyFact['nativeEvidence']>['obligation'],
): boolean {
  return (
    obligation !== null &&
    summarizeCompilationObligation(obligation) === 'required'
  );
}

function loadedAdmission(
  observed: NativeResolution,
): NativeDependencyFact['admission'] {
  return observed.compilerLoad === 'loaded' ? 'admitted' : 'excluded';
}

function nativeSemanticResolution(
  entry: NativeRequestRecord,
  observed: NativeResolution,
  origin: ResolutionOrigin | undefined,
): TypeScriptSemanticResolution {
  return {
    channel: semanticChannel(entry),
    identity: nativeFingerprint([entry.request.id, observed]),
    redirectedReferenceIdentity:
      observed.rawRedirectEvidenceIds.length === 0
        ? null
        : nativeFingerprint(observed.rawRedirectEvidenceIds),
    resolutionMode: resolutionMode(entry.request.resolutionMode),
    target: checkerTarget(observed, origin),
  };
}

function semanticChannel(
  entry: NativeRequestRecord,
): TypeScriptSemanticChannel {
  if (entry.record.kind === 'jsx-import-source') return 'jsx-runtime';
  const channels: Partial<
    Record<NativeRequestRecord['request']['channel'], TypeScriptSemanticChannel>
  > = {
    'path-directive': 'triple-slash-path',
    'type-directive': 'triple-slash-types',
    library: 'lib-environment',
    implicit: 'environment-pragma',
  };
  return channels[entry.request.channel] ?? 'module';
}

function resolutionMode(mode: string | null): ts.ResolutionMode {
  return mode === null ? undefined : (Number(mode) as ts.ResolutionMode);
}

function checkerTarget(
  observed: NativeResolution,
  origin: ResolutionOrigin | undefined,
): ResolvedCheckerModuleName | null {
  if (observed.target === null) return null;
  return {
    resolvedBy: 'typescript',
    resolvedFileName: observed.target.lexicalPath,
    isExternalLibraryImport: observed.externalLibrary === true,
    ...(origin !== undefined && { resolutionOrigin: origin }),
  };
}
