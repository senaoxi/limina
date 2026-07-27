import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import {
  addSourceReferenceConfigProblems,
  readImplicitRefs,
} from './generated/config-readers';
import { getDtsConfigPathForSourcePath } from './project-indexes';
import type { SourceProject } from './types';

function formatUnmappedImplicitReference(options: {
  config: ResolvedLiminaConfig;
  path: string;
  project: SourceProject;
  targetConfigPath: string;
}): string {
  return [
    'Unable to map Limina implicit reference to a generated declaration project:',
    `  config: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    '  field: liminaOptions.implicitRefs',
    `  reference: ${options.path}`,
    `  resolved: ${toRelativePath(options.config.rootDir, options.targetConfigPath)}`,
    '  reason: implicitRefs must point to an ordinary source tsconfig selected by the same checker.include set.',
  ].join('\n');
}

function addImplicitReference(options: {
  config: ResolvedLiminaConfig;
  localDtsProjectsBySourcePath: Map<string, SourceProject[]>;
  path: string;
  problems: string[];
  project: SourceProject;
  targetConfigPath: string;
}): void {
  const targetDtsConfigPath = getDtsConfigPathForSourcePath({
    checkerName: options.project.checkerName,
    dtsProjectsBySourcePath: options.localDtsProjectsBySourcePath,
    sourceConfigPath: options.targetConfigPath,
  });
  if (!targetDtsConfigPath) {
    options.problems.push(formatUnmappedImplicitReference(options));
    return;
  }
  options.project.references.add(targetDtsConfigPath);
}

export function addImplicitProjectReferences(options: {
  config: ResolvedLiminaConfig;
  localDtsProjectsBySourcePath: Map<string, SourceProject[]>;
  problems: string[];
  project: SourceProject;
}): void {
  addSourceReferenceConfigProblems({
    config: options.config,
    problems: options.problems,
    sourceConfigPath: options.project.configPath,
  });
  const collection = readImplicitRefs(
    options.config,
    options.project.configPath,
  );
  options.problems.push(...collection.problems);
  for (const implicitRef of collection.implicitRefs) {
    addImplicitReference({
      ...options,
      path: implicitRef.path,
      targetConfigPath: implicitRef.targetConfigPath,
    });
  }
}
