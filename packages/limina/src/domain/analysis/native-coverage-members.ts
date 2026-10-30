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
  readonly #current = new Map<string, NativeFileIdentity>();
  readonly #lexical = new Map<string, Set<string>>();
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
    let hasCurrentIdentities = true;
    for (const file of config.members) {
      if (file.physical.state !== 'verified') {
        hasCurrentIdentities = false;
        continue;
      }
      this.#recordLexical(file.lexicalPath, file.physical.canonicalId);
      if (file.physical.inputVersion !== this.#version)
        hasCurrentIdentities = false;
      else if (!this.#current.has(file.physical.canonicalId))
        this.#current.set(file.physical.canonicalId, file);
    }
    this.hasCurrentIdentities = hasCurrentIdentities;
  }

  #recordLexical(lexical: string, canonical: string): void {
    let identities = this.#lexical.get(lexical);
    if (identities === undefined) {
      identities = new Set();
      this.#lexical.set(lexical, identities);
    }
    identities.add(canonical);
  }

  firstMatch(target: NativeFileIdentity): NativeFileIdentity | undefined {
    if (
      target.physical.state !== 'verified' ||
      target.physical.inputVersion !== this.#version
    )
      return undefined;
    // Preserve the first matching alias, even before a later lexical match.
    return this.#current.get(target.physical.canonicalId);
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
    const physical = target.physical;
    return index
      .get(fileKey(target.lexicalPath))
      ?.find(
        (member) =>
          member.physical.state === 'verified' &&
          member.physical.inputVersion === this.#version &&
          member.physical.canonicalId === physical.canonicalId,
      );
  }

  hasConflict(target: NativeFileIdentity): boolean {
    if (target.physical.state !== 'verified') return false;
    const identities = this.#lexical.get(target.lexicalPath);
    if (identities === undefined) return false;
    // Stale verified identities still conflict; they cannot grant membership.
    return identities.size > 1 || !identities.has(target.physical.canonicalId);
  }
}
