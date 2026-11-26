import { toRelativePath } from '#utils/path';
import type { DeclarationContextDecision } from '../../domain/analysis/declaration-context';
import type { DeclarationCompilationEvidence } from '../../domain/analysis/declaration-governance';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import type { ReferenceImportContext } from './reference-import-types';
import { recordReferencePackageRequest } from './reference-package-request';
import type { GeneratedDependencyEdge, SourceProject } from './types';

/**
Policy references use the existing graph, never a fabricated compiler fact.
*/
export function addDeclarationContextReferences(options: {
  context: ReferenceImportContext;
  project: SourceProject;
  evidence: DeclarationCompilationEvidence | undefined;
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
  const requests =
    options.evidence?.requestOrigins.filter((item) =>
      decision.requestIds.includes(item.id),
    ) ?? [];
  for (const origin of requests)
    recordReferencePackageRequest(
      context.analysis,
      {
        consumerProject: project.dtsConfigPath,
        providerProject: provider.dtsConfigPath,
        file: origin.file,
        specifier: origin.specifier,
      },
      origin.binding?.channel,
    );
  const request = requests[0];
  const source = request?.file ?? project.configPath;
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
}
