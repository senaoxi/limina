import type ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type {
  NativeRequest,
  NativeResolution,
} from '../../domain/analysis/native-evidence';
import { nativeFingerprint } from './native-file-identity';
import type { NativeIdentityObservations } from './native-identity-observations';

export interface NativeRequestInput {
  pathSelection?: NativeResolution['pathSelection'];
  source?: ts.SourceFile;
  position: number;
  channel: NativeRequest['channel'];
  name: string;
  mode?: ts.ResolutionMode;
  target?: string;
  external?: boolean;
  ambient?: boolean;
  unavailable?: boolean;
  redirects?: readonly string[];
  configField?: string;
}

export interface NativeRequestResult {
  request: NativeRequest;
  resolution: NativeResolution;
}

export function nativeRequestId(
  context: NativeEvidenceContext,
  input: NativeRequestInput,
): string {
  return nativeFingerprint([
    context.id,
    input.source?.fileName,
    input.position,
    input.channel,
    input.name,
    input.mode,
  ]);
}

function sourceEntry(
  input: NativeRequestInput,
  identities: NativeIdentityObservations,
): NativeRequest['entry'] | undefined {
  return input.source === undefined || input.position < 0
    ? undefined
    : {
        kind: 'source',
        file: identities.read(input.source.fileName),
        position: input.position,
      };
}

function compilerEntry(
  input: NativeRequestInput,
  configId: string,
): NativeRequest['entry'] {
  const reason = compilerReason(input, configId);
  return input.configField === undefined
    ? {
        kind: 'compiler',
        reason,
      }
    : { kind: 'config', configId, field: input.configField };
}

function compilerReason(input: NativeRequestInput, configId: string) {
  return `${input.channel}:${input.source?.fileName ?? configId}`;
}

export function nativeRequest(
  context: NativeEvidenceContext,
  input: NativeRequestInput,
  identities: NativeIdentityObservations,
): NativeRequest {
  return {
    id: nativeRequestId(context, input),
    consumerContextId: context.id,
    origin: { source: 'typescript-observation', family: 'typescript', context },
    channel: input.channel,
    sourceFile: sourceIdentity(input, identities),
    entry:
      sourceEntry(input, identities) ??
      compilerEntry(input, context.inputs.config),
    specifier: input.name,
    resolutionMode: input.mode === undefined ? null : String(input.mode),
    predecessorId: null,
  };
}

function sourceIdentity(
  input: NativeRequestInput,
  identities: NativeIdentityObservations,
) {
  return input.source === undefined
    ? null
    : identities.read(input.source.fileName);
}

function missingResolutionState(
  input: NativeRequestInput,
): NativeResolution['state'] {
  if (input.ambient) return 'ambient';
  return input.unavailable ? 'unavailable' : 'unresolved';
}

export function nativeResolution(
  requestId: string,
  input: NativeRequestInput,
  identities: NativeIdentityObservations,
): NativeResolution {
  return {
    requestId,
    ...(input.pathSelection !== undefined && {
      pathSelection: input.pathSelection,
    }),
    state:
      input.target === undefined ? missingResolutionState(input) : 'resolved',
    target: resolutionTarget(input.target, identities),
    ...resolutionMetadata(input),
    compilerLoad: 'not-observed',
    evidenceIds: [requestId],
  };
}

function resolutionTarget(
  target: string | undefined,
  identities: NativeIdentityObservations,
) {
  return target === undefined ? null : identities.read(target);
}

function resolutionMetadata(input: NativeRequestInput) {
  return {
    externalLibrary: input.external ?? null,
    rawRedirectEvidenceIds: input.redirects ?? [],
  };
}
