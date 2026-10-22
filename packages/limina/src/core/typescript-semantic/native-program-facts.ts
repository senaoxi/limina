import type { ResolvedCheckerModuleName } from '#checkers';
import type ts from 'typescript';
import type { NativeResolution } from '../../domain/analysis/native-evidence';
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
import type { NativeRequestRecord } from './native-program-records';
import { observedDeclarationRedirect } from './reference-redirect';
import { getResolutionOrigin } from './resolution-origin';

export function nativeProgramFacts(
  adapter: NativeObservationAdapter,
  entries: readonly NativeRequestRecord[],
): Map<string, NativeDependencyFact> {
  const resolutions = new Map(
    adapter.snapshot.resolutions.map((item) => [item.requestId, item]),
  );
  const obligations = new Map(
    adapter.snapshot.obligations.flatMap((item) =>
      item.requestIds.map((id) => [id, item] as const),
    ),
  );
  const modules = new Map(
    adapter.modules.map((item) => [item.requestId, item.raw?.resolvedModule]),
  );
  return new Map(
    entries.map((entry) => [
      createImportRecordIdentity(entry.record),
      nativeProgramFact({
        adapter,
        entry,
        observed: resolutions.get(entry.request.id)!,
        obligation: obligations.get(entry.request.id) ?? null,
        raw: modules.get(entry.request.id),
      }),
    ]),
  );
}

function nativeProgramFact(input: {
  adapter: NativeObservationAdapter;
  entry: NativeRequestRecord;
  observed: NativeResolution;
  obligation: NonNullable<NativeDependencyFact['nativeEvidence']>['obligation'];
  raw: ts.ResolvedModuleFull | undefined;
}): NativeDependencyFact {
  const { adapter, entry, observed, obligation, raw } = input;
  const target = observed.target?.lexicalPath;
  const coverage = targetCoverage(adapter, target);
  const resolution = nativeSemanticResolution(entry, observed, raw);
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
    redirect: targetRedirect(adapter, target),
  };
}

function targetCoverage(
  adapter: NativeObservationAdapter,
  target: string | undefined,
) {
  return target === undefined
    ? null
    : adapter.frontier.inspect(target).coverage;
}

function targetRedirect(
  adapter: NativeObservationAdapter,
  target: string | undefined,
) {
  return target === undefined
    ? undefined
    : observedDeclarationRedirect(adapter.references.get(target));
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
  raw: ts.ResolvedModuleFull | undefined,
): TypeScriptSemanticResolution {
  return {
    channel: semanticChannel(entry),
    identity: nativeFingerprint([entry.request.id, observed]),
    redirectedReferenceIdentity:
      observed.rawRedirectEvidenceIds.length === 0
        ? null
        : nativeFingerprint(observed.rawRedirectEvidenceIds),
    resolutionMode: resolutionMode(entry.request.resolutionMode),
    target: checkerTarget(observed, raw),
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
  raw: ts.ResolvedModuleFull | undefined,
): ResolvedCheckerModuleName | null {
  if (observed.target === null) return null;
  return {
    resolvedBy: 'typescript',
    resolvedFileName: observed.target.lexicalPath,
    isExternalLibraryImport: observed.externalLibrary === true,
    ...(raw !== undefined && { resolutionOrigin: getResolutionOrigin(raw) }),
  };
}
