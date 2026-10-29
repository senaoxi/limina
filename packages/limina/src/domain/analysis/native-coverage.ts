/**
 * Coverage proof contract. Producers must establish the universe from activated entry
 * selection/solution traversal, before parsing its members. Neither extends
 * inputs nor generated configs become source configs by being read.
 */
import { publishedCoverageMembers } from './native-coverage-members';
import { freezeNativeData } from './native-evidence-freeze';

type MemberView = ReturnType<typeof publishedCoverageMembers>;

export interface NativeFileIdentity {
  readonly lexicalPath: string;
  readonly physical:
    | {
        readonly state: 'verified';
        readonly canonicalId: string;
        readonly evidenceId: string;
        readonly inputVersion: string;
      }
    | { readonly state: 'unavailable'; readonly reason: string };
}

export interface SourceConfigUniverse {
  readonly id: string;
  readonly revision: string;
  readonly inputVersion: string;
  readonly selectionEvidenceId: string;
  readonly scopeFingerprint: string;
  readonly sourceConfigIds: readonly string[];
  readonly discovery: 'closed' | 'open';
}

export type SourceConfigEnumeration =
  | {
      readonly configId: string;
      readonly inputVersion: string;
      readonly state: 'enumerated';
      readonly evidenceId: string;
      readonly members: readonly NativeFileIdentity[];
      readonly complete: boolean;
    }
  | {
      readonly configId: string;
      readonly inputVersion: string;
      readonly state: 'failed';
      readonly failureId: string;
      readonly impact:
        | { readonly kind: 'unbounded' }
        | {
            readonly kind: 'proven-exclusion';
            readonly evidenceId: string;
            readonly excludedCanonicalIds: readonly string[];
          };
    };

export interface SourceConfigCoverageIndex {
  readonly universe: SourceConfigUniverse;
  readonly inputVersion: string;
  readonly configurations: readonly SourceConfigEnumeration[];
}

export interface SourceConfigMember {
  readonly configId: string;
  readonly membershipEvidenceId: string;
  readonly match: 'lexical' | 'canonical';
}

export interface NativeCoverage {
  readonly universeId: string;
  readonly indexRevision: string;
  readonly inputVersion: string;
  readonly target: NativeFileIdentity;
  readonly members: readonly SourceConfigMember[];
  readonly completeness: 'complete' | 'incomplete';
  readonly gaps: readonly string[];
  readonly state: 'uncovered' | 'unavailable' | 'unique' | 'ambiguous';
}

function hasVerifiedIdentity(
  file: NativeFileIdentity,
  version: string,
): boolean {
  return (
    file.physical.state === 'verified' && file.physical.inputVersion === version
  );
}

function isSamePhysicalFile(
  a: NativeFileIdentity,
  b: NativeFileIdentity,
): boolean {
  return (
    a.physical.state === 'verified' &&
    b.physical.state === 'verified' &&
    a.physical.canonicalId === b.physical.canonicalId
  );
}

function memberMatch(a: NativeFileIdentity, b: NativeFileIdentity) {
  if (a.lexicalPath === b.lexicalPath) return 'lexical' as const;
  return isSamePhysicalFile(a, b) ? ('canonical' as const) : undefined;
}

function enumerationGaps(
  config: SourceConfigEnumeration,
  target: NativeFileIdentity,
): string[] {
  if (config.state === 'enumerated')
    return config.complete ? [] : ['member-enumeration-open'];
  return failedConfigGaps(config, target);
}

function failedConfigGaps(
  config: Extract<SourceConfigEnumeration, { state: 'failed' }>,
  target: NativeFileIdentity,
) {
  return config.impact.kind === 'unbounded'
    ? [config.failureId]
    : exclusionGaps(
        config.impact.excludedCanonicalIds,
        target,
        config.failureId,
      );
}

function exclusionGaps(
  excluded: readonly string[],
  target: NativeFileIdentity,
  failure: string,
) {
  if (target.physical.state !== 'verified') return [failure];
  return excluded.includes(target.physical.canonicalId) ? [] : [failure];
}

function inspectConfig(
  config: SourceConfigEnumeration,
  index: SourceConfigCoverageIndex,
  view: MemberView,
) {
  if (config.state === 'failed') return [];
  const isComplete =
    view?.hasCurrentIdentities ??
    config.members.every((file) =>
      hasVerifiedIdentity(file, index.inputVersion),
    );
  return isComplete ? [] : ['member-identity-unavailable'];
}

function collectMember(
  config: SourceConfigEnumeration,
  target: NativeFileIdentity,
  version: string,
  view: MemberView,
) {
  if (config.state !== 'enumerated') return [];
  const member =
    view === undefined
      ? config.members.find((file) => currentMemberMatch(file, target, version))
      : view.firstMatch(target);
  if (!member) return [];
  return [
    {
      configId: config.configId,
      membershipEvidenceId: config.evidenceId,
      match: memberMatch(member, target)!,
    },
  ];
}

function currentMemberMatch(
  a: NativeFileIdentity,
  b: NativeFileIdentity,
  version: string,
) {
  const hasCurrentIdentity = [a, b].every((file) =>
    hasVerifiedIdentity(file, version),
  );
  return hasCurrentIdentity && !hasConflictingIdentity(a, b)
    ? memberMatch(a, b)
    : undefined;
}

function hasConflictingIdentity(
  a: NativeFileIdentity,
  b: NativeFileIdentity,
): boolean {
  return (
    a.physical.state === 'verified' &&
    b.physical.state === 'verified' &&
    a.physical.canonicalId !== b.physical.canonicalId
  );
}

function identityConflictGaps(
  config: SourceConfigEnumeration,
  target: NativeFileIdentity,
  view: MemberView,
): string[] {
  if (config.state !== 'enumerated') return [];
  const hasConflict =
    view?.hasConflict(target) ??
    config.members.some(
      (member) =>
        member.lexicalPath === target.lexicalPath &&
        hasConflictingIdentity(member, target),
    );
  return hasConflict ? ['lexical-identity-conflict'] : [];
}

function coverageState(
  count: number,
  isComplete: boolean,
): NativeCoverage['state'] {
  if (count > 1) return 'ambiguous';
  const singleState = (['uncovered', 'unique'] as const)[count]!;
  return isComplete ? singleState : 'unavailable';
}

function universeGaps(index: SourceConfigCoverageIndex): string[] {
  const ids = index.universe.sourceConfigIds;
  const gaps = discoveryGaps(index);
  if (new Set(ids).size !== ids.length) gaps.push('duplicate-universe-member');
  return gaps;
}

function discoveryGaps(index: SourceConfigCoverageIndex): string[] {
  if (index.universe.inputVersion !== index.inputVersion)
    return ['universe-input-drift'];
  return index.universe.discovery === 'closed' ? [] : ['discovery-open'];
}

function currentConfigurations(
  index: SourceConfigCoverageIndex,
  configId: string,
) {
  return index.universe.inputVersion === index.inputVersion
    ? index.configurations.filter(
        (config) =>
          config.configId === configId &&
          config.inputVersion === index.inputVersion,
      )
    : [];
}

/**
A lexical hit never bypasses examination of other configs/canonical aliases.
*/
export function deriveNativeCoverage(
  index: SourceConfigCoverageIndex,
  target: NativeFileIdentity,
): NativeCoverage {
  const ids = new Set(index.universe.sourceConfigIds).values().toArray();
  const observations = ids.map((id) => observeConfig(index, target, id));
  const gaps = [
    ...universeGaps(index),
    ...targetIdentityGaps(target, index.inputVersion),
    ...observations.flatMap((observation) => observation.gaps),
  ];
  const members = observations.flatMap((observation) => observation.members);
  return freezeNativeData({
    universeId: index.universe.id,
    indexRevision: index.universe.revision,
    inputVersion: index.inputVersion,
    target,
    members,
    completeness: gaps.length === 0 ? 'complete' : 'incomplete',
    gaps,
    state: coverageState(members.length, gaps.length === 0),
  });
}

function targetIdentityGaps(
  target: NativeFileIdentity,
  version: string,
): string[] {
  return hasVerifiedIdentity(target, version)
    ? []
    : ['target-identity-unavailable'];
}

function observeConfig(
  index: SourceConfigCoverageIndex,
  target: NativeFileIdentity,
  id: string,
) {
  const configs = currentConfigurations(index, id);
  if (configs.length !== 1)
    return { gaps: [`config-unavailable:${id}`], members: [] };
  const config = configs[0]!;
  const view = publishedCoverageMembers(config);
  return {
    gaps: [
      ...inspectConfig(config, index, view),
      ...enumerationGaps(config, target),
      ...identityConflictGaps(config, target, view),
    ],
    members: collectMember(config, target, index.inputVersion, view),
  };
}
