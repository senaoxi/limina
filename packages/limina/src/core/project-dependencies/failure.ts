import { normalizeAbsolutePath } from '#utils/path';
import type {
  ProjectDependencyFailure,
  ProjectDependencyFailureStage,
  ProjectDependencyRequest,
} from './contracts';

const FAILURE_STAGE_BY_SOURCE = {
  'module-resolution': 'module-resolution',
  'service-script-materialization': 'generated-script-materialization',
  'source-map-ambiguity': 'source-map-ambiguity',
  'source-map-mismatch': 'source-map-mismatch',
  'toolchain-compatibility': 'toolchain-compatibility',
  'toolchain-resolution': 'toolchain-resolution',
} as const satisfies Partial<Record<string, ProjectDependencyFailureStage>>;

const SHARED_PREPARATION_FAILURE_STAGES = new Set([
  'context-creation',
  'toolchain-compatibility',
  'toolchain-resolution',
]);

export function mapFailureStage(stage: string): ProjectDependencyFailureStage {
  return (
    FAILURE_STAGE_BY_SOURCE[stage as keyof typeof FAILURE_STAGE_BY_SOURCE] ??
    'project-materialization'
  );
}

function getFailureFilePath(
  importRecord: ProjectDependencyFailure['importRecord'],
): string | null {
  return importRecord?.filePath ?? null;
}

function createDefaultFailureIdentity(options: {
  framework: ProjectDependencyFailure['framework'];
  importRecord?: ProjectDependencyFailure['importRecord'];
  request: ProjectDependencyRequest;
  stage: ProjectDependencyFailureStage;
}): string {
  return JSON.stringify({
    configPath: options.request.context.configPath,
    filePath: getFailureFilePath(options.importRecord),
    framework: options.framework,
    stage: options.stage,
  });
}

export function createProjectDependencyFailure(options: {
  identity?: string;
  reason: string;
  request: ProjectDependencyRequest;
  stage: ProjectDependencyFailureStage;
  importRecord?: ProjectDependencyFailure['importRecord'];
}): ProjectDependencyFailure {
  const framework = options.request.context.semanticAuthority.family;
  return {
    configPath: options.request.context.configPath,
    framework,
    identity:
      options.identity ??
      createDefaultFailureIdentity({ ...options, framework }),
    importRecord: options.importRecord,
    reason: options.reason,
    stage: options.stage,
  };
}

export function createPreparationFailureIdentity(options: {
  fileName: string;
  request: ProjectDependencyRequest;
  stage: string;
}): string | undefined {
  if (SHARED_PREPARATION_FAILURE_STAGES.has(options.stage)) return undefined;
  return JSON.stringify({
    configPath: options.request.context.configPath,
    filePath: normalizeAbsolutePath(options.fileName),
    framework: options.request.context.semanticAuthority.family,
    stage: mapFailureStage(options.stage),
  });
}
