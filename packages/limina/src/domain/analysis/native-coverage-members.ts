import type {
  NativeFileIdentity,
  SourceConfigEnumeration,
} from './native-coverage';
import { isPublishedNativeData } from './native-evidence-freeze';

type Enumeration = Extract<SourceConfigEnumeration, { state: 'enumerated' }>;
const members = new WeakMap<Enumeration, CoverageMembers>();

/**
A derived view of one privately published enumeration, never file authority.
*/
export function publishedCoverageMembers(
  config: SourceConfigEnumeration,
): CoverageMembers | undefined {
  if (config.state !== 'enumerated' || !isPublishedNativeData(config))
    return undefined;
  let view = members.get(config);
  if (view === undefined) {
    view = new CoverageMembers(config);
    members.set(config, view);
  }
  return view;
}

class CoverageMembers {
  readonly #compilerMembers = new Map<
    (file: string) => string,
    Map<string, NativeFileIdentity[]>
  >();
  readonly #members: readonly NativeFileIdentity[];
  readonly #version: string;
  readonly hasCurrentIdentities: boolean;

  constructor(config: Enumeration) {
    this.#version = config.inputVersion;
    this.#members = config.members;
    this.hasCurrentIdentities = config.members.every(
      (file) =>
        file.physical.state === 'verified' &&
        file.physical.inputVersion === this.#version,
    );
  }

  #entries(
    target: NativeFileIdentity,
    fileKey: (file: string) => string,
  ): readonly NativeFileIdentity[] {
    let index = this.#compilerMembers.get(fileKey);
    if (index === undefined) {
      index = new Map();
      for (const member of this.#members) {
        const key = fileKey(member.lexicalPath);
        const entries = index.get(key) ?? [];
        entries.push(member);
        index.set(key, entries);
      }
      this.#compilerMembers.set(fileKey, index);
    }
    return index.get(fileKey(target.lexicalPath)) ?? [];
  }

  compilerMatch(
    target: NativeFileIdentity,
    fileKey: (file: string) => string,
  ): NativeFileIdentity | undefined {
    if (
      target.physical.state !== 'verified' ||
      target.physical.inputVersion !== this.#version
    )
      return undefined;
    const physical = target.physical;
    return this.#entries(target, fileKey).find(
      (member) =>
        member.physical.state === 'verified' &&
        member.physical.inputVersion === this.#version &&
        member.physical.canonicalId === physical.canonicalId,
    );
  }

  hasConflict(
    target: NativeFileIdentity,
    fileKey: (file: string) => string,
  ): boolean {
    const physical = target.physical;
    if (physical.state !== 'verified') return false;
    // Stale bindings still conflict, although they cannot grant membership.
    return this.#entries(target, fileKey).some(
      (member) =>
        member.physical.state === 'verified' &&
        member.physical.canonicalId !== physical.canonicalId,
    );
  }
}
