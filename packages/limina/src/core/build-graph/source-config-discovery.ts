import type ts from 'typescript';
import type {
  NativeFileIdentity,
  SourceConfigCoverageIndex,
  SourceConfigEnumeration,
} from '../../domain/analysis/native-coverage';
import { freezeNativeData } from '../../domain/analysis/native-evidence-freeze';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import {
  nativeFingerprint,
  observeNativeFileIdentity,
} from '../typescript-semantic/native-file-identity';
import { isNodeModulesPath } from '../workspace/lookup/shared';

const declarationPositions = new WeakMap<
  SourceConfigCoverageIndex,
  Map<string, number[]>
>();

export function managedDeclarationRoots(
  coverage: SourceConfigCoverageIndex,
  entry: Extract<SourceConfigEnumeration, { state: 'enumerated' }>,
): readonly NativeFileIdentity[] {
  const positions = declarationPositions.get(coverage)?.get(entry.configId);
  return positions === undefined
    ? entry.members.filter((file) => isManagedDeclarationRoot(file.lexicalPath))
    : positions.map((position) => entry.members[position]!);
}

export function isManagedDeclarationRoot(file: string): boolean {
  return isDeclarationFile(file) && !isNodeModulesPath(file);
}

interface ConfigVisit {
  role: 'pending' | 'source' | 'solution';
  files: readonly string[];
  basis?: unknown;
}

export function sourceConfigBasis(input: {
  configClosure: readonly { filePath: string }[];
  options: ts.CompilerOptions;
  references: readonly ts.ProjectReference[];
}): unknown {
  return [
    input.configClosure.map(({ filePath }) => filePath),
    effectiveCompilerOptions(input.options),
    input.references,
  ];
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
    this.#closed = this.#visits
      .values()
      .every(({ role }) => role !== 'pending');
  }

  snapshot(): SourceConfigCoverageIndex {
    const sources = [...this.#visits].filter(
      ([, visit]) => visit.role !== 'solution',
    );
    const scope = nativeFingerprint(this.#entries);
    const positions = new Map<string, number[]>();
    const observed = sources.map(([configId, visit]) => {
      const declarations: number[] = [];
      positions.set(configId, declarations);
      return enumeration(configId, visit, 'discovery', declarations);
    });
    const version = nativeFingerprint([
      this.#version,
      this.#entries,
      [...this.#visits],
      observed,
    ]);
    const configurations = observed.map((config) =>
      rebindEnumeration(config, version),
    );
    const index = freezeNativeData<SourceConfigCoverageIndex>({
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
    declarationPositions.set(index, positions);
    return index;
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
  declarations: number[],
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
  const members = visit.files.map((file, position) => {
    if (isManagedDeclarationRoot(file)) declarations.push(position);
    return observeNativeFileIdentity(file, version);
  });
  return {
    configId,
    inputVersion: version,
    state: 'enumerated',
    evidenceId: nativeFingerprint([configId, version, members]),
    members,
    complete: true,
  };
}
