import { createReleaseFinding } from '../findings/evidence';
import type { ReleaseFinding } from '../findings/types';
import type { RegistryAuthorityError } from './authority';

export function createRegistryAuthorityFinding(
  error: RegistryAuthorityError,
  options: {
    dependencyName: string;
    importerName: string;
    filePath: string;
  },
): ReleaseFinding {
  return createReleaseFinding({
    code: 'LIMINA_RELEASE_REGISTRY',
    facts: {
      kind: 'authority-invalid',
      dependencyName: options.dependencyName,
      importerName: options.importerName,
      registryUrl: '[invalid authority]',
      authoritySource: error.source,
      errorMessage: error.message,
    },
    filePath: options.filePath,
    packageManifestPath: options.filePath,
    packageName: options.dependencyName,
    presentation: {
      problemLines: [error.message],
      section: 'registry-content',
      sectionTitle: 'Release registry authority is invalid:',
      summary: error.message,
      title: 'Release registry authority is invalid',
    },
  });
}
