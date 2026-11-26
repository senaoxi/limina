import type { ResolvedLiminaInputs } from '#config/runner';
import { isOrdinarySourceTypecheckConfigPath } from '#core/tsconfig/actions';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type {
  NativeCoverage,
  NativeFileIdentity,
  SourceConfigCoverageIndex,
} from '../../domain/analysis/native-coverage';
import { deriveCompilerCoverage } from '../typescript-semantic/compiler-coverage';
import { observeNativeFileIdentity } from '../typescript-semantic/native-file-identity';
import { isNodeModulesPath } from '../workspace/lookup/shared';
import { readDeclarationContextChoices } from './declaration-context-options';
import { managedDeclarationRoots } from './source-config-discovery';

type Selection = DeclarationContextDecision['selection'];
type FileKey = (file: string) => string;
export interface DeclarationContextPolicy {
  declarationRoots(config: string): readonly NativeFileIdentity[] | undefined;
  readonly problems: ReadonlyMap<string, string[]>;
  select(
    consumer: string,
    proof: NativeCoverage,
    fileKey: FileKey,
    diagnostics: Set<string>,
  ): Selection;
  hasChoice(file: string, key: FileKey): boolean;
  choiceDiagnostics(config: string, key: FileKey): readonly string[];
}

interface Choice {
  owner: string;
  file: NativeFileIdentity;
  config: NativeFileIdentity;
}

function hasSameBinding(a: NativeFileIdentity, b: NativeFileIdentity) {
  return (
    a.physical.state === 'verified' &&
    b.physical.state === 'verified' &&
    a.physical.inputVersion === b.physical.inputVersion &&
    a.physical.canonicalId === b.physical.canonicalId
  );
}

/** Current discovery and parsed compilation units supply the eligible choices.
 * This policy is shared by ownership and graph projection within one run. */
export function createDeclarationContextPolicy(input: {
  config: ResolvedLiminaInputs;
  coverage: SourceConfigCoverageIndex;
  units: Iterable<string>;
  inRegion: (config: string) => boolean;
}): DeclarationContextPolicy {
  const { coverage, inRegion } = input;
  const enumerations = new Map(
    coverage.configurations.map((item) => [item.configId, item]),
  );
  const sourceIds = new Set(coverage.universe.sourceConfigIds);
  const units = new Set(
    [...input.units].filter(
      (id) =>
        sourceIds.has(id) &&
        inRegion(id) &&
        enumerations.get(id)?.state === 'enumerated',
    ),
  );
  const identities = new Map<string, NativeFileIdentity>();
  const choices: Choice[] = [];
  const problems = new Map<string, string[]>();
  function identity(path: string) {
    const previous = identities.get(path);
    if (previous) return previous;
    const receipt = observeNativeFileIdentity(path, coverage.inputVersion);
    identities.set(path, receipt);
    return receipt;
  }
  for (const owner of units) {
    const parsed = readDeclarationContextChoices(input.config, owner);
    problems.set(owner, parsed.problems);
    for (const choice of parsed.choices)
      choices.push({
        owner,
        file: identity(choice.file),
        config: identity(choice.config),
      });
  }
  const roots = new Map<string, readonly NativeFileIdentity[]>();
  function declarationRoots(config: string) {
    const prior = roots.get(config);
    if (prior !== undefined) return prior;
    const entry = enumerations.get(config);
    const files =
      entry?.state === 'enumerated'
        ? managedDeclarationRoots(coverage, entry)
        : undefined;
    if (files) roots.set(config, files);
    return files;
  }
  const indexedChoices = new Map<FileKey, Map<string, Choice[]>>();
  function choicesFor(file: string, key: FileKey) {
    let indexed = indexedChoices.get(key);
    if (indexed === undefined) {
      indexed = new Map();
      for (const choice of choices) {
        const name = key(choice.file.lexicalPath);
        const entries = indexed.get(name) ?? [];
        entries.push(choice);
        indexed.set(name, entries);
      }
      indexedChoices.set(key, indexed);
    }
    return indexed.get(key(file)) ?? [];
  }
  function candidates(proof: NativeCoverage) {
    return proof.members
      .map((member) => member.configId)
      .filter((id) => units.has(id));
  }
  function assessChoice(
    choice: Choice,
    proof: NativeCoverage,
    members: readonly string[],
    key: FileKey,
  ):
    | { state: 'valid'; config: string }
    | { state: 'invalid' | 'unavailable'; reason: string } {
    const path = choice.config.lexicalPath;
    if (isNodeModulesPath(choice.file.lexicalPath))
      return {
        state: 'invalid',
        reason: 'external declaration outside managed source coverage',
      };
    if (!isOrdinarySourceTypecheckConfigPath(path, input.config.rootDir))
      return { state: 'invalid', reason: 'not an ordinary Source Config path' };
    if (!inRegion(path))
      return { state: 'invalid', reason: 'outside the activated Regions' };
    if (
      !sourceIds.has(path) &&
      coverage.universe.discovery === 'closed' &&
      [...sourceIds].every((id) => key(id) !== key(path))
    )
      return {
        state: 'invalid',
        reason: 'not a discovered ordinary Source Config',
      };
    if (proof.completeness !== 'complete')
      return {
        state: 'unavailable',
        reason: 'declaration Coverage is incomplete',
      };
    const matching = members.filter((member) => key(member) === key(path));
    if (matching.length === 0)
      return {
        state: 'invalid',
        reason: 'no active compilation unit covering the declaration',
      };
    const unit = matching[0]!;
    if (
      matching.length !== 1 ||
      !hasSameBinding(choice.file, proof.target) ||
      !hasSameBinding(choice.config, identity(unit))
    )
      return {
        state: 'unavailable',
        reason:
          'compiler path and physical binding do not establish one identity',
      };
    return { state: 'valid', config: unit };
  }
  function select(
    consumer: string,
    proof: NativeCoverage,
    fileKey: FileKey,
    diagnostics: Set<string>,
  ): Selection {
    const members = candidates(proof);
    const selected = new Set<string>();
    let isUncertain = members.some(
      (config) => identity(config).physical.state !== 'verified',
    );
    for (const choice of choicesFor(proof.target.lexicalPath, fileKey)) {
      const result = assessChoice(choice, proof, members, fileKey);
      if (result.state === 'valid') selected.add(result.config);
      else {
        isUncertain ||= result.state === 'unavailable';
        diagnostics.add(
          `${choice.owner}: ${result.state} declarationContexts choice for ${choice.file.lexicalPath} -> ${choice.config.lexicalPath}: ${result.reason}.`,
        );
      }
    }
    if (isUncertain || proof.completeness !== 'complete')
      return {
        state: 'unavailable',
        reason: `Declaration Coverage or path binding is incomplete: ${proof.gaps.join(', ')}`,
      };
    if (selected.size > 1)
      return {
        state: 'awaiting-selection',
        reason: `Conflicting valid declarationContexts choices: ${[...selected].join(', ')}.`,
      };
    const explicit = selected.values().next().value;
    const target = explicit ?? (members.length === 1 ? members[0] : undefined);
    if (target === consumer) return { state: 'local', config: target };
    if (target !== undefined)
      return {
        state: 'selected',
        config: target,
        basis: explicit ? 'explicit-selection' : 'unique-coverage',
      };
    if (members.length === 0)
      return {
        state: 'unavailable',
        reason: 'No active compilation unit proves declaration coverage.',
      };
    return {
      state: 'awaiting-selection',
      reason:
        'Choose a declaration context with liminaOptions.declarationContexts.',
    };
  }
  return {
    declarationRoots,
    choiceDiagnostics(config, key) {
      const diagnostics = new Set<string>();
      for (const choice of choices)
        if (choice.owner === config)
          select(
            config,
            deriveCompilerCoverage(coverage, choice.file, key),
            key,
            diagnostics,
          );
      return [...diagnostics];
    },
    problems,
    select,
    hasChoice: (file: string, key: FileKey) => choicesFor(file, key).length > 0,
  };
}
