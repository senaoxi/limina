import { freezeNativeData } from './native-evidence-freeze';

export type NativeSemanticFamily = 'typescript' | 'vue' | 'astro' | 'svelte';

/**
Fingerprints cover actual values, not merely the tsconfig path.
*/
export interface NativeContextInputs {
  readonly typescriptVersion: string;
  readonly typescriptImplementation: string;
  readonly toolchain: string;
  readonly hostContract: string;
  readonly config: string;
  readonly sourceConfig?: string;
  readonly roots: string;
  readonly options: string;
  readonly rawReferences: string;
  readonly coverage: string;
  readonly sourceVersion: string;
  readonly compilationScope: string;
}

export interface NativeEvidenceContext {
  readonly id: string;
  readonly epoch: string;
  readonly collectionId: string;
  readonly inputs: NativeContextInputs;
  readonly authority:
    | { readonly phase: 'pending'; readonly baseline: 'typescript' }
    | {
        readonly phase: 'locked';
        readonly family: NativeSemanticFamily;
        readonly selectionEvidenceIds: readonly string[];
      };
}

interface NativeOriginContext {
  readonly context: NativeEvidenceContext;
}

export type NativeEvidenceOrigin = NativeOriginContext &
  (
    | {
        readonly source: 'typescript-observation';
        readonly family: 'typescript';
      }
    | {
        readonly source: 'framework-candidate' | 'framework-semantic';
        readonly family: Exclude<NativeSemanticFamily, 'typescript'>;
      }
  );

/**
Preserve the collection context independently of later phase/input changes.
*/
export function captureNativeEvidenceOrigin(
  origin: NativeEvidenceOrigin,
): NativeEvidenceOrigin {
  return freezeNativeData(origin);
}

export type NativeEvidenceUse =
  | 'pending-observation'
  | 'ownership-selection'
  | 'locked-fact';
export type NativeEvidenceEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: 'stale-context' | 'wrong-source-or-phase';
    };

function hasSameInputs(
  a: NativeContextInputs,
  b: NativeContextInputs,
): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    (Object.keys(a) as (keyof NativeContextInputs)[]).every(
      (key) => a[key] === b[key],
    )
  );
}

function hasSameContext(
  a: NativeEvidenceContext,
  b: NativeEvidenceContext,
): boolean {
  const ids = [a.id, a.epoch, a.collectionId];
  const expected = [b.id, b.epoch, b.collectionId];
  return (
    ids.every((id, index) => id === expected[index]) &&
    hasSameContextMeaning(a, b)
  );
}

function hasSameContextMeaning(
  a: NativeEvidenceContext,
  b: NativeEvidenceContext,
): boolean {
  return [
    a.authority.phase === b.authority.phase,
    hasSameInputs(a.inputs, b.inputs),
    authorityFamily(a) === authorityFamily(b),
    hasSameSelectionEvidence(a.authority, b.authority),
  ].every(Boolean);
}

function hasSameSelectionEvidence(
  a: NativeEvidenceContext['authority'],
  b: NativeEvidenceContext['authority'],
): boolean {
  return (
    JSON.stringify(selectionEvidence(a)) ===
    JSON.stringify(selectionEvidence(b))
  );
}
function selectionEvidence(
  authority: NativeEvidenceContext['authority'],
): readonly string[] {
  return authority.phase === 'locked' ? authority.selectionEvidenceIds : [];
}

function authorityFamily(context: NativeEvidenceContext): NativeSemanticFamily {
  return context.authority.phase === 'pending'
    ? 'typescript'
    : context.authority.family;
}

function isNativeBaseline(origin: NativeEvidenceOrigin): boolean {
  return (
    origin.source === 'typescript-observation' && origin.family === 'typescript'
  );
}

function isPendingSource(
  origin: NativeEvidenceOrigin,
  use: NativeEvidenceUse,
): boolean {
  if (use === 'locked-fact') return false;
  return origin.source === 'framework-candidate'
    ? use === 'ownership-selection'
    : isNativeBaseline(origin);
}

function semanticSource(family: NativeSemanticFamily) {
  return family === 'typescript'
    ? 'typescript-observation'
    : 'framework-semantic';
}

function isLockedSource(
  origin: NativeEvidenceOrigin,
  use: NativeEvidenceUse,
): boolean {
  return (
    use === 'locked-fact' &&
    origin.family === authorityFamily(origin.context) &&
    origin.source === semanticSource(origin.family)
  );
}

/**
Eligibility is recomputed against the current context; it is not a persisted capability.
*/
export function qualifyNativeEvidence(
  origin: NativeEvidenceOrigin,
  current: NativeEvidenceContext,
  use: NativeEvidenceUse,
): NativeEvidenceEligibility {
  return hasSameContext(origin.context, current)
    ? sourceEligibility(origin, use)
    : { eligible: false, reason: 'stale-context' };
}

function sourceEligibility(
  origin: NativeEvidenceOrigin,
  use: NativeEvidenceUse,
): NativeEvidenceEligibility {
  const isEligible =
    origin.context.authority.phase === 'pending'
      ? isPendingSource(origin, use)
      : isLockedSource(origin, use);
  return isEligible
    ? { eligible: isEligible }
    : { eligible: isEligible, reason: 'wrong-source-or-phase' };
}

interface SelectedNativeAuthority {
  readonly state: 'selected';
  readonly context: NativeEvidenceContext;
  readonly family: NativeSemanticFamily;
  readonly evidenceIds: readonly string[];
  readonly nextContextId: string;
  readonly nextCollectionId: string;
}

export type NativeAuthoritySelection =
  | SelectedNativeAuthority
  | {
      readonly state: 'ambiguous' | 'unavailable';
      readonly candidateFamilies: readonly NativeSemanticFamily[];
      readonly evidenceIds: readonly string[];
    };

export type NativeLockResult =
  | { readonly state: 'collect-fresh'; readonly context: NativeEvidenceContext }
  | {
      readonly state: 'conflict';
      readonly reason:
        | 'already-locked'
        | 'identity-reused'
        | 'selection-undetermined'
        | 'stale-selection';
    };

/**
No retry/reselection loop, final executable checker, or evidence relabeling here.
*/
export function lockNativeEvidenceContext(
  pending: NativeEvidenceContext,
  selection: NativeAuthoritySelection,
): NativeLockResult {
  if (pending.authority.phase === 'locked')
    return { state: 'conflict', reason: 'already-locked' };
  return canSelectAuthority(selection)
    ? lockSelectedContext(pending, selection)
    : { state: 'conflict', reason: 'selection-undetermined' };
}

function canSelectAuthority(
  selection: NativeAuthoritySelection,
): selection is SelectedNativeAuthority {
  return selection.state === 'selected' && selection.evidenceIds.length > 0;
}

function lockSelectedContext(
  pending: NativeEvidenceContext,
  selection: SelectedNativeAuthority,
): NativeLockResult {
  if (!hasSameContext(pending, selection.context))
    return { state: 'conflict', reason: 'stale-selection' };
  if (isIdentityReused(pending, selection))
    return { state: 'conflict', reason: 'identity-reused' };
  return freezeNativeData({
    state: 'collect-fresh',
    context: {
      ...pending,
      id: selection.nextContextId,
      collectionId: selection.nextCollectionId,
      authority: {
        phase: 'locked',
        family: selection.family,
        selectionEvidenceIds: [...selection.evidenceIds],
      },
    },
  });
}

function isIdentityReused(
  context: NativeEvidenceContext,
  selection: SelectedNativeAuthority,
) {
  return (
    context.id === selection.nextContextId ||
    context.collectionId === selection.nextCollectionId
  );
}
