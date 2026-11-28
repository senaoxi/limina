import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import { existsSync } from 'node:fs';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { CheckCounter } from '../execution/stats';
import { createSourceDiagnosticFinding } from './finding-utilities';
import type { SourceFinding } from './findings';
import { addProjectOwnerProblems } from './project-owner-findings';
import type { SourceProjectEntry } from './source-types';

function addProjectLabelFinding(options: {
  findings: SourceFinding[];
  project: ProjectInfo;
}): void {
  const diagnostic = options.project.labelDiagnostic;
  if (!diagnostic) {
    return;
  }

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceTsconfigGovernance,
      facts: {
        configPath: diagnostic.projectPath,
        field: diagnostic.field,
        kind: 'project-label',
        value: diagnostic.value,
      },
      filePath: diagnostic.projectPath,
      lines: diagnostic.detailLines,
      locations: [
        { filePath: diagnostic.projectPath, label: 'project' },
        { label: 'field', scope: diagnostic.field },
      ],
      reason: diagnostic.reason,
      scope: diagnostic.field,
      title: diagnostic.title,
    }),
  );
}

interface ProjectOwnershipOptions {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  companionFileNames: string[];
  project: ProjectInfo;
  workspaceLookup: WorkspaceLookupIndex;
}

function getProjectOwnershipRole(
  isDtsProject: boolean,
): 'declaration leaf' | 'governed source' {
  return isDtsProject ? 'declaration leaf' : 'governed source';
}

function addCompanionProjectOwnership(
  options: ProjectOwnershipOptions,
  isDtsProject: boolean,
): void {
  if (!isDtsProject) return;
  const typecheckConfigPath = options.project.resolverConfigPath;
  if (!existsSync(typecheckConfigPath)) return;
  addProjectOwnerProblems({
    checks: options.checks,
    config: options.config,
    configPath: typecheckConfigPath,
    fileNames: options.companionFileNames,
    findings: options.findings,
    role: 'typecheck companion',
    workspaceLookup: options.workspaceLookup,
  });
}

function addProjectOwnership(options: ProjectOwnershipOptions): void {
  addProjectLabelFinding(options);
  const isDtsProject = isDtsProjectConfig(options.project.configPath);
  addProjectOwnerProblems({
    checks: options.checks,
    config: options.config,
    configPath: options.project.configPath,
    fileNames: options.project.ownedFileNames,
    findings: options.findings,
    role: getProjectOwnershipRole(isDtsProject),
    workspaceLookup: options.workspaceLookup,
  });
  addCompanionProjectOwnership(options, isDtsProject);
}

export function addSourceProjectOwnerProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  findings: SourceFinding[];
  sourceProjectEntries: SourceProjectEntry[];
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  for (const { project, companionFileNames } of options.sourceProjectEntries) {
    addProjectOwnership({ ...options, project, companionFileNames });
  }
}
