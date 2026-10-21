import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { NativeIdentityObservations } from './native-identity-observations';
import {
  nativeRequest,
  nativeRequestId,
  type NativeRequestInput,
  type NativeRequestResult,
  nativeResolution,
} from './native-program-request-data';

export interface NativeModuleObservation {
  readonly requestId: string;
  readonly source: ts.SourceFile;
  readonly literal: ts.StringLiteralLike;
  readonly mode: ts.ResolutionMode;
  readonly raw: ts.ResolvedModuleWithFailedLookupLocations | undefined;
  readonly role: 'import' | 'augmentation';
}

export class NativeProgramRequests {
  readonly #entries = new Map<string, NativeRequestResult>();
  readonly optionsBySource: Map<ts.SourceFile, ts.CompilerOptions> = new Map();
  readonly context: NativeEvidenceContext;
  readonly identities: NativeIdentityObservations;

  constructor(
    context: NativeEvidenceContext,
    identities: NativeIdentityObservations,
  ) {
    this.context = context;
    this.identities = identities;
  }

  get entries(): readonly NativeRequestResult[] {
    return this.#entries.values().toArray();
  }

  record(input: NativeRequestInput): string {
    const id = nativeRequestId(this.context, input);
    const previous = this.#entries.get(id);
    const redirects =
      input.redirects ?? previous?.resolution.rawRedirectEvidenceIds;
    this.#entries.set(id, {
      request: nativeRequest(this.context, input, this.identities),
      resolution: nativeResolution(
        id,
        { ...input, redirects },
        this.identities,
      ),
    });
    return id;
  }

  moduleCallback(input: {
    source: ts.SourceFile;
    literal: ts.StringLiteralLike;
    mode: ts.ResolutionMode;
    raw: ts.ResolvedModuleWithFailedLookupLocations;
    redirect: ts.ResolvedProjectReference | undefined;
  }): void {
    this.record({
      source: input.source,
      position: input.literal.pos,
      channel: moduleChannel(input.literal),
      name: input.literal.text,
      mode: input.mode,
      ...moduleTarget(input.raw.resolvedModule),
      redirects: redirectIds(input.redirect),
    });
  }

  typeCallback(input: {
    reference: ts.FileReference | string;
    source: ts.SourceFile | undefined;
    mode: ts.ResolutionMode;
    raw: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations | undefined;
    redirect: ts.ResolvedProjectReference | undefined;
    configField?: string;
  }): void {
    this.record({
      source: input.source,
      ...typeReferenceEntry(input.reference),
      channel: 'type-directive',
      mode: input.mode,
      ...typeTarget(input.raw),
      redirects: redirectIds(input.redirect),
      configField: input.configField,
    });
  }
}

export function moduleChannel(
  literal: ts.StringLiteralLike,
): 'implicit' | 'module' {
  return literal.pos < 0 ? 'implicit' : 'module';
}

function moduleTarget(
  target:
    | { resolvedFileName?: string; isExternalLibraryImport?: boolean }
    | undefined,
) {
  return {
    target: target?.resolvedFileName,
    external: target?.isExternalLibraryImport,
  };
}

function typeTarget(
  raw: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations | undefined,
) {
  return raw === undefined
    ? { unavailable: true }
    : moduleTarget(raw.resolvedTypeReferenceDirective);
}

function typeReferenceEntry(reference: ts.FileReference | string) {
  return typeof reference === 'string'
    ? { position: -1, name: reference }
    : { position: reference.pos, name: reference.fileName };
}

function redirectIds(
  reference: ts.ResolvedProjectReference | undefined,
): string[] | undefined {
  return reference === undefined
    ? undefined
    : [normalizeAbsolutePath(reference.sourceFile.fileName)];
}
