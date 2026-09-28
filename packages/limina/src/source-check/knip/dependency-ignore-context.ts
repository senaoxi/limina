import type { WorkspacePackage } from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import path from 'pathe';
import {
  createWorkspaceDependencyKey,
  type WorkspaceDependencyDeclaration,
} from '../../core/packages/authority';
import type { PackageOwnerIdentity } from '../../core/workspace/owner-identity';
import type { SourceFinding } from '../findings';
import type { SourceKnipWorkspaceConfigRecord } from './routing';

export interface DependencyIgnoreContext {
  declarationKeys: Set<string>;
  findings: SourceFinding[];
  configs: Map<PackageOwnerIdentity, SourceKnipWorkspaceConfigRecord>;
  workspacePackageNames: Set<string>;
}

export interface ParsedDependencyIgnore {
  dependencyName: string;
  reason: string;
}

export function createContext(options: {
  declarations: WorkspaceDependencyDeclaration[];
  findings: SourceFinding[];
  workspacePackages: WorkspacePackage[];
  knipWorkspaceConfigs: Map<
    PackageOwnerIdentity,
    SourceKnipWorkspaceConfigRecord
  >;
}): DependencyIgnoreContext {
  const namedPackages = options.workspacePackages.filter(
    isNamedWorkspacePackage,
  );
  return {
    declarationKeys: new Set(
      options.declarations.map((declaration) =>
        createWorkspaceDependencyKey(
          declaration.importerIdentity,
          declaration.dependencyName,
        ),
      ),
    ),
    findings: options.findings,
    configs: options.knipWorkspaceConfigs,
    workspacePackageNames: new Set(namedPackages.map((entry) => entry.name)),
  };
}

export function getPackageJsonPath(
  context: DependencyIgnoreContext,
  importerIdentity: PackageOwnerIdentity,
): string | undefined {
  const owner = context.configs.get(importerIdentity)?.owner;
  return owner === undefined
    ? undefined
    : path.join(owner.directory, 'package.json');
}
