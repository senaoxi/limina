import { addRegistryFinding } from '../consistency/findings';
import { RegistryTarballError } from '../consistency/types';
import {
  type EffectiveRegistryAuthority,
  RegistryAuthorityError,
} from '../registry/authority';
import { createRegistryAuthorityFinding } from '../registry/authority-finding';
import { resolveRegistryTarballUrl } from '../registry/tarball-url';
import type { WorkspaceRegistryContext } from './registry-types';
type ResolvedRegistryContext = WorkspaceRegistryContext & {
  authority: EffectiveRegistryAuthority;
};

export function validateTarballUrl(
  value: string,
  context: ResolvedRegistryContext,
  registryUrl: string,
): string | null {
  try {
    return resolveRegistryTarballUrl(value, context.authority);
  } catch (error) {
    if (!(error instanceof RegistryTarballError)) throw error;
    addRegistryFinding(context.state, {
      facts: {
        ...error.failure,
        dependencyName: context.dependencyName,
        importerName: context.importerName,
        registryUrl,
      },
      filePath: context.sourceManifestPath,
      packageManifestPath: context.sourceManifestPath,
      packageName: context.dependencyName,
      message: error.message,
    });
    return null;
  }
}

export function resolveAuthority(
  context: WorkspaceRegistryContext,
): EffectiveRegistryAuthority | null {
  try {
    return context.state.registryConfiguration.authorityFor(
      context.dependencyName,
    );
  } catch (error) {
    if (!(error instanceof RegistryAuthorityError)) throw error;
    context.state.findings.push(
      createRegistryAuthorityFinding(error, {
        ...context,
        filePath: context.sourceManifestPath,
      }),
    );
    return null;
  }
}
