import { toRelativePath } from '#utils/path';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { NativeEvidenceSnapshot } from '../../domain/analysis/native-evidence';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { ReferenceImportContext } from './reference-import-types';
import type { GeneratedDependencyEdge, SourceProject } from './types';

/**
Policy references use the existing graph, never a fabricated compiler fact.
*/
export function addDeclarationContextReferences(options: {
  context: ReferenceImportContext;
  project: SourceProject;
  snapshot: NativeEvidenceSnapshot | undefined;
  decisions: readonly DeclarationContextDecision[];
}): void {
  for (const decision of options.decisions) {
    if (decision.selection.state !== 'selected') continue;
    const providers =
      options.context.dtsProjectsBySourcePath.get(decision.selection.config) ??
      [];
    const provider = providers.find(
      (item) => item.checkerName === options.project.checkerName,
    );
    if (provider === undefined) {
      options.context.problems.push(
        `${decision.consumerConfig}: declaration context ${decision.selection.config} has no provider with checker ${options.project.checkerName}.`,
      );
      continue;
    }
    addPolicyReference({ ...options, provider, decision });
  }
}

function addPolicyReference(
  options: Parameters<typeof addDeclarationContextReferences>[0] & {
    provider: SourceProject;
    decision: DeclarationContextDecision;
  },
): void {
  const { context, project, provider, decision } = options;
  const request = options.snapshot?.requests.find((item) =>
    decision.requestIds.includes(item.id),
  );
  const source = request?.sourceFile?.lexicalPath ?? project.configPath;
  const edge: GeneratedDependencyEdge = {
    kind: 'declaration-provider',
    cacheReuse: 'reusable',
    fromChecker: project.checkerName,
    toChecker: provider.checkerName,
    fromConfigPath: project.configPath,
    toConfigPath: provider.configPath,
    file: toRelativePath(context.config.rootDir, source),
    importedSpecifier: request?.specifier ?? decision.file.lexicalPath,
    resolvedFilePath: decision.file.lexicalPath,
  };
  project.references.add(provider.dtsConfigPath);
  context.dependencyEdgesByKey.set(
    nativeFingerprint(['declaration-context', edge]),
    edge,
  );
  context.projectDependencyCaches.analysisCache?.contributions.record({
    occurrence: {
      filePath: source,
      policy: 'declaration-context',
      requestIds: [...decision.requestIds],
    },
    fromChecker: edge.fromChecker,
    toChecker: edge.toChecker,
    fromConfigPath: edge.fromConfigPath,
    toConfigPath: edge.toConfigPath,
    kind: edge.kind,
    basis: {
      kind: 'declaration-context',
      evidence: nativeFingerprint(decision),
    },
  });
}
