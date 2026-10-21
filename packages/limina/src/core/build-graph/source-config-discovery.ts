import type {
  SourceConfigCoverageIndex,
  SourceConfigEnumeration,
} from '../../domain/analysis/native-coverage';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import {
  nativeFingerprint,
  observeNativeFileIdentity,
} from '../typescript-semantic/native-file-identity';

interface ConfigVisit {
  role: 'pending' | 'source' | 'solution';
  files: readonly string[];
  basis?: unknown;
}

/**
 * Records selected/traversed candidates before parsing. Successful parses may
 * prove a solution role; failed parses cannot silently shrink the universe.
 */
export class SourceConfigDiscovery {
  readonly #visits = new Map<string, ConfigVisit>();
  readonly #entries: readonly string[];
  readonly #version: string;
  #closed = false;

  constructor(entries: readonly string[], version: string) {
    this.#entries = [...entries];
    this.#version = version;
    for (const entry of entries) this.begin(entry);
  }

  begin(config: string): void {
    if (!this.#visits.has(config))
      this.#visits.set(config, { role: 'pending', files: [] });
  }

  parsed(
    config: string,
    files: readonly string[],
    proof: { isSolution: boolean; basis: unknown },
  ): void {
    this.#visits.set(config, {
      role: proof.isSolution ? 'solution' : 'source',
      files: [...files],
      basis: proof.basis,
    });
  }

  close(): void {
    this.#closed = true;
  }

  snapshot(): SourceConfigCoverageIndex {
    const sources = [...this.#visits].filter(
      ([, visit]) => visit.role !== 'solution',
    );
    const scope = nativeFingerprint(this.#entries);
    const observed = sources.map(([configId, visit]) =>
      enumeration(configId, visit, 'discovery'),
    );
    const version = nativeFingerprint([
      this.#version,
      this.#entries,
      [...this.#visits],
      observed,
    ]);
    const configurations = observed.map((config) =>
      rebindEnumeration(config, version),
    );
    return freezeNativeData({
      universe: {
        id: scope,
        revision: nativeFingerprint([version, configurations]),
        inputVersion: version,
        selectionEvidenceId: nativeFingerprint([
          'entry-selection-and-solution-traversal',
          this.#entries,
        ]),
        scopeFingerprint: scope,
        sourceConfigIds: sources.map(([config]) => config),
        discovery: this.#closed ? 'closed' : 'open',
      },
      inputVersion: version,
      configurations,
    });
  }
}

function rebindEnumeration(
  config: SourceConfigEnumeration,
  inputVersion: string,
): SourceConfigEnumeration {
  if (config.state === 'failed') return { ...config, inputVersion };
  return {
    ...config,
    inputVersion,
    members: config.members.map((member) => ({
      ...member,
      physical:
        member.physical.state === 'verified'
          ? { ...member.physical, inputVersion }
          : member.physical,
    })),
  };
}

function enumeration(
  configId: string,
  visit: ConfigVisit,
  version: string,
): SourceConfigEnumeration {
  if (visit.role === 'pending')
    return {
      configId,
      inputVersion: version,
      state: 'failed',
      failureId: nativeFingerprint([
        'source-config-not-enumerated',
        configId,
        version,
      ]),
      impact: { kind: 'unbounded' },
    };
  const members = visit.files.map((file) =>
    observeNativeFileIdentity(file, version),
  );
  return {
    configId,
    inputVersion: version,
    state: 'enumerated',
    evidenceId: nativeFingerprint([configId, version, members]),
    members,
    complete: true,
  };
}
