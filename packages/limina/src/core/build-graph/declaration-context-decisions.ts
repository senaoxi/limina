import type { ResolvedLiminaInputs } from '#config/runner';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { DeclarationCompilationEvidence } from '../../domain/analysis/declaration-governance';
import {
  deriveNativeCoverage,
  type NativeFileIdentity,
  type SourceConfigCoverageIndex,
} from '../../domain/analysis/native-coverage';
import type { ProjectDependency } from '../project-dependencies/contracts';
import {
  nativeFingerprint,
  observeNativeFileIdentity,
} from '../typescript-semantic/native-file-identity';
import { readDeclarationContextChoices } from './declaration-context-options';

export function declarationFileKey(file: NativeFileIdentity): string {
  return file.physical.state === 'verified'
    ? file.physical.canonicalId
    : file.lexicalPath;
}

export function collectDeclarationContextDecisions(options: {
  config: ResolvedLiminaInputs;
  project: { configPath: string; fileNames: readonly string[] };
  evidence: DeclarationCompilationEvidence | undefined;
  unsupportedDependencies?: readonly ProjectDependency[];
  coverageIndex?: SourceConfigCoverageIndex;
  isWorkspaceFile?: (file: string) => boolean;
}): { decisions: DeclarationContextDecision[]; problems: string[] } {
  const { project, evidence } = options;
  const read = readDeclarationContextChoices(
    options.config,
    project.configPath,
  );
  const decisions: DeclarationContextDecision[] = unsupportedDecisions(options);
  const index = options.coverageIndex;
  if (index === undefined) return { decisions, problems: read.problems };
  const identity = (file: string) =>
    observeNativeFileIdentity(file, index.inputVersion);
  const roots = new Set(
    project.fileNames.map((file) => declarationFileKey(identity(file))),
  );
  const choices = new Map<string, string>();
  for (const choice of read.choices) {
    const file = identity(choice.file);
    const key = declarationFileKey(file);
    const coverage = deriveNativeCoverage(index, file);
    const previous = choices.get(key);
    if (
      (previous !== undefined && previous !== choice.config) ||
      (roots.has(key) && choice.config !== project.configPath) ||
      coverage.members.every((member) => member.configId !== choice.config)
    )
      read.problems.push(
        `${project.configPath}: invalid or conflicting declarationContexts choice for ${choice.file} -> ${choice.config}.`,
      );
    else choices.set(key, choice.config);
  }
  if (evidence === undefined) return { decisions, problems: read.problems };
  for (const relation of evidence.declarations) {
    if (
      relation.consumerConfig !== project.configPath ||
      relation.contextId !== evidence.contextId
    )
      continue;
    const coverage = deriveNativeCoverage(index, relation.file);
    // Unmanaged declarations retain the existing boundary; no producer is inferred.
    if (
      coverage.members.length === 0 &&
      !(
        coverage.state === 'unavailable' &&
        options.isWorkspaceFile?.(relation.file.lexicalPath)
      )
    )
      continue;
    const key = declarationFileKey(relation.file);
    decisions.push({
      kind: relation.kind,
      consumerConfig: project.configPath,
      contextId: evidence.contextId,
      file: relation.file,
      requestIds: relation.requestIds,
      coverage,
      selection: chooseContext(
        coverage,
        roots.has(key),
        project.configPath,
        choices.get(key),
      ),
    });
  }
  return { decisions, problems: read.problems };
}

function chooseContext(
  coverage: DeclarationContextDecision['coverage'],
  isLocal: boolean,
  consumer: string,
  explicit: string | undefined,
): DeclarationContextDecision['selection'] {
  if (
    isLocal &&
    coverage.members.some((member) => member.configId === consumer)
  )
    return { state: 'local', config: consumer };
  if (coverage.completeness !== 'complete')
    return {
      state: 'unavailable',
      reason: `Declaration Coverage is incomplete: ${coverage.gaps.join(', ')}`,
    };
  if (
    explicit !== undefined &&
    coverage.members.some((member) => member.configId === explicit)
  )
    return { state: 'selected', config: explicit, basis: 'explicit-selection' };
  if (coverage.state === 'unique')
    return {
      state: 'selected',
      config: coverage.members[0]!.configId,
      basis: 'unique-coverage',
    };
  return {
    state: 'awaiting-selection',
    reason:
      'Choose a declaration context with liminaOptions.declarationContexts.',
  };
}

function unsupportedDecisions(
  options: Parameters<typeof collectDeclarationContextDecisions>[0],
): DeclarationContextDecision[] {
  const index = options.coverageIndex;
  if (index === undefined || options.evidence !== undefined) return [];
  const localInputs = new Set(
    options.project.fileNames.map((file) =>
      declarationFileKey(observeNativeFileIdentity(file, index.inputVersion)),
    ),
  );
  return (options.unsupportedDependencies ?? []).flatMap((dependency) => {
    if (dependency.targetKind !== 'declaration') return [];
    const file = observeNativeFileIdentity(
      dependency.resolvedFilePath,
      index.inputVersion,
    );
    const coverage = deriveNativeCoverage(index, file);
    if (coverage.members.length === 0) return [];
    // Existing framework analysis owns its local inputs. Qualification is needed
    // for a new cross-project context delegation, not for local ambient support.
    if (
      localInputs.has(declarationFileKey(file)) &&
      coverage.members.some(
        (member) => member.configId === options.project.configPath,
      )
    )
      return [];
    return [
      {
        kind: 'consumption' as const,
        consumerConfig: options.project.configPath,
        contextId: nativeFingerprint(dependency.evidence),
        file,
        requestIds: [],
        coverage,
        selection: {
          state: 'unavailable' as const,
          reason:
            'Managed declaration contexts require a qualified Checker declaration adapter.',
        },
      },
    ];
  });
}
