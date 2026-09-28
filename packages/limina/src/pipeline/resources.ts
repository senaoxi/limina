import type { BuiltinTaskName } from '#config/runner';
import type { ResourceRequest } from '../execution/resources';

const repositoryRead = ['repository:snapshot', 'workspace:manifest'] as const;

const builtinTaskResources: Record<BuiltinTaskName, ResourceRequest> = {
  'checker:build': {
    read: [
      ...repositoryRead,
      'preflight:generated-graph',
      'workspace:generated-files',
    ],
    write: ['checker:build-cache'],
  },
  'checker:typecheck': {
    read: [
      ...repositoryRead,
      'preflight:generated-graph',
      'workspace:generated-files',
    ],
    write: ['checker:typecheck-cache'],
  },
  'graph:check': {
    read: [
      ...repositoryRead,
      'preflight:generated-graph',
      'preflight:workspace-packages',
      'preflight:importers',
    ],
  },
  'graph:prepare': {
    read: [
      ...repositoryRead,
      'preflight:generated-graph',
      'workspace:generated-files',
    ],
  },
  'package:check': {
    read: [...repositoryRead, 'package-out'],
    write: ['package-tarball'],
  },
  'proof:check': {
    read: [
      ...repositoryRead,
      'preflight:generated-graph',
      'preflight:graph-project-routes',
      'preflight:checker-entry-project-routes',
      'preflight:expected-source-files',
    ],
  },
  'release:check': {
    read: [...repositoryRead, 'package-out'],
    write: ['release-tarball'],
  },
  'source:check': {
    read: [
      'repository:snapshot',
      'preflight:generated-graph',
      'preflight:workspace-packages',
      'preflight:package-owners',
      'preflight:workspace-dependency-declarations',
    ],
    write: ['workspace:manifest', 'workspace:temporary-files'],
  },
};

export function getBuiltinTaskResources(
  taskName: BuiltinTaskName,
): ResourceRequest {
  return builtinTaskResources[taskName];
}
