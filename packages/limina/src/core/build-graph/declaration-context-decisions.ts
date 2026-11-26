import type { VueProjectSemanticIdentity } from '#checkers';
import { vueCompilerPathPolicy } from '../../checker/vue-semantic-identity';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type {
  DeclarationCompilationEvidence,
  DeclarationObservation,
} from '../../domain/analysis/declaration-governance';
import type {
  NativeCoverage,
  SourceConfigCoverageIndex,
} from '../../domain/analysis/native-coverage';
import type { ReferenceDependency } from '../project-dependencies/reference-facts';
import { deriveCompilerCoverage } from '../typescript-semantic/compiler-coverage';
import { nativeCompilerPathPolicy } from '../typescript-semantic/compiler-path-key';
import {
  nativeFingerprint,
  observeNativeFileIdentity,
} from '../typescript-semantic/native-file-identity';
import { isNodeModulesPath } from '../workspace/lookup/shared';
import type { DeclarationContextPolicy } from './declaration-context-policy';
import {
  type DeclarationRequestScope,
  declarationRequestScope,
} from './declaration-request-scope';
import { isManagedDeclarationRoot } from './source-config-discovery';

export interface DeclarationContextProjection extends DeclarationRequestScope {
  decisions: DeclarationContextDecision[];
  diagnostics: string[];
  problems: string[];
}

export function collectDeclarationContextDecisions(options: {
  project: {
    configPath: string;
    fileNames: readonly string[];
    ownedFileNames?: readonly string[];
    context?: { vueSemanticIdentity?: VueProjectSemanticIdentity };
  };
  evidence: DeclarationCompilationEvidence | undefined;
  unsupportedDependencies?: readonly ReferenceDependency[];
  allowUnqualifiedLocal: boolean;
  coverageIndex?: SourceConfigCoverageIndex;
  policy?: DeclarationContextPolicy;
  isWorkspaceFile?: (file: string) => boolean;
}): DeclarationContextProjection {
  const { project, evidence, policy, coverageIndex: index } = options;
  const contextId =
    evidence?.contextId ??
    nativeFingerprint(['unqualified-declarations', project.configPath]);
  const fileKey =
    project.context?.vueSemanticIdentity === undefined
      ? nativeCompilerPathPolicy().key
      : vueCompilerPathPolicy(project.context.vueSemanticIdentity).key;
  const decisions: DeclarationContextDecision[] = [];
  const diagnostics = new Set(
    policy?.choiceDiagnostics(project.configPath, fileKey),
  );
  const problems = policy?.problems.get(project.configPath) ?? [];
  const roots =
    policy?.declarationRoots(project.configPath) ??
    (project.ownedFileNames ?? project.fileNames)
      .filter(isManagedDeclarationRoot)
      .map((file) =>
        observeNativeFileIdentity(file, index?.inputVersion ?? 'unavailable'),
      );
  const observations: DeclarationObservation[] = (
    evidence?.declarations ?? []
  ).filter(
    (item) =>
      item.contextId === contextId &&
      item.consumerConfig === project.configPath,
  );
  const unsupported = options.unsupportedDependencies ?? [];
  if (index && !evidence)
    for (const dependency of unsupported)
      if (dependency.targetKind === 'declaration')
        observations.push({
          kind: 'consumption',
          contextId,
          consumerConfig: project.configPath,
          file: observeNativeFileIdentity(
            dependency.resolvedFilePath,
            index.inputVersion,
          ),
          requestIds: [],
        });
  // Keep real incoming occurrences when available. A complete parsed root is
  // independently active even if its only incoming request is later excluded.
  const rootObservations = new Set(
    observations
      .filter((item) => item.kind === 'root-input')
      .map((item) => fileKey(item.file.lexicalPath)),
  );
  for (const file of roots)
    if (!rootObservations.has(fileKey(file.lexicalPath)))
      observations.push({
        kind: 'root-input',
        consumerConfig: project.configPath,
        contextId,
        file,
        requestIds: [],
      });
  for (const observation of observations) {
    if (isNodeModulesPath(observation.file.lexicalPath)) continue;
    if (!index || !policy) {
      if (
        observation.kind === 'root-input' ||
        options.isWorkspaceFile?.(observation.file.lexicalPath)
      ) {
        const coverage: NativeCoverage = index
          ? deriveCompilerCoverage(index, observation.file, fileKey)
          : {
              universeId: 'unavailable',
              indexRevision: 'unavailable',
              inputVersion: 'unavailable',
              target: observation.file,
              members: [],
              completeness: 'incomplete',
              gaps: ['source-config-coverage-unavailable'],
              state: 'unavailable',
            };
        decisions.push({
          ...observation,
          coverage,
          selection: {
            state: 'unavailable',
            reason: 'The active declaration compilation units are unavailable.',
          },
        });
      }
      continue;
    }
    const coverage = deriveCompilerCoverage(index, observation.file, fileKey);
    if (
      observation.kind !== 'root-input' &&
      coverage.members.length === 0 &&
      !(
        (coverage.completeness === 'incomplete' ||
          policy.hasChoice(observation.file.lexicalPath, fileKey)) &&
        options.isWorkspaceFile?.(observation.file.lexicalPath)
      )
    )
      continue;
    let selection = policy.select(
      project.configPath,
      coverage,
      fileKey,
      diagnostics,
    );
    if (
      !evidence &&
      selection.state !== 'local' &&
      selection.state !== 'awaiting-selection'
    )
      selection = {
        state: 'unavailable',
        reason:
          'Managed declaration contexts require a qualified Checker declaration adapter.',
      };
    // Unqualified adapters can continue checking their own unique roots.
    if (!evidence && selection.state === 'local') {
      if (options.allowUnqualifiedLocal && coverage.members.length === 1)
        continue;
      selection = {
        state: 'unavailable',
        reason:
          'The selected declaration context has no qualified Checker request inventory.',
      };
    }
    decisions.push({ ...observation, coverage, selection });
  }
  const scope = declarationRequestScope(
    project.configPath,
    evidence,
    decisions,
    roots,
    fileKey,
  );
  const active = decisions.flatMap((item) => {
    if (item.kind === 'root-input' || item.requestIds.length === 0)
      return [item];
    const ids = item.requestIds.filter((id) => !scope.inactiveRequests.has(id));
    if (ids.length === 0) return [];
    return [
      ids.length === item.requestIds.length
        ? item
        : { ...item, requestIds: ids },
    ];
  });
  return {
    decisions: active,
    diagnostics: [...diagnostics],
    problems,
    ...scope,
  };
}
