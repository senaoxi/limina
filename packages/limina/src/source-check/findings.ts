import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { createLiminaCheckIssue } from '../check-reporting/structured';
import type { SourceKnipConfigInvalidFacts } from './finding-facts';
import type {
  SourceFinding,
  SourceFindingForCode,
  SourceUnusedModuleFinding,
  SourceUnusedWorkspaceDependencyFinding,
} from './finding-types';
import type { CanonicalLiminaCheckIssue } from './snapshot';

export type * from './finding-facts';
export type * from './finding-types';
export { SOURCE_SEMANTIC_ISSUE_CODES } from './finding-types';

export function createSourceKnipConfigFinding(options: {
  dependencyName?: string;
  field: string;
  file?: string;
  importerName?: string;
  kind: SourceKnipConfigInvalidFacts['kind'];
  lines: readonly string[];
  packageJsonPath?: string;
  packageName?: string;
  reason: string;
  title: string;
  value?: unknown;
}): SourceFindingForCode<
  typeof LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid
> {
  return {
    code: LIMINA_CHECK_ISSUE_CODES.sourceKnipConfigInvalid,
    detector: 'source',
    evidence: [{ label: 'diagnostic', lines: [...options.lines] }],
    external: { tool: 'knip' },
    facts: {
      dependencyName: options.dependencyName,
      field: options.field,
      file: options.file,
      importerName: options.importerName,
      kind: options.kind,
      packageName: options.packageName,
      value: options.value,
    },
    locations: [{ label: 'field', scope: options.field }],
    ownerName: options.packageName ?? '<workspace>',
    packageJsonPath: options.packageJsonPath,
    reason: options.reason,
    scope: options.field,
    summary: options.title,
    task: 'source:check',
    title: options.title,
    tool: 'knip',
    verifyCommands: ['limina source check'],
  };
}

export function createSourceUnusedModuleFinding(options: {
  externalCode: string;
  externalMessage?: string;
  filePath: string;
  ownerDirectory: string;
  ownerName: string;
  packageJsonPath: string;
}): SourceUnusedModuleFinding {
  return {
    code: LIMINA_CHECK_ISSUE_CODES.sourceUnusedModule,
    detector: 'knip',
    evidence: [],
    external: {
      code: options.externalCode,
      message: options.externalMessage,
      tool: 'knip',
    },
    facts: {
      filePath: options.filePath,
      kind: 'unused-module',
      ownerDirectory: options.ownerDirectory,
      packageManifestPath: options.packageJsonPath,
      packageName: options.ownerName,
    },
    filePath: options.filePath,
    fixSteps: [
      'Delete files that are truly unused.',
      'Make files reachable from package manifest entries, binaries, scripts, or Knip plugin entries.',
      `Add intentional files to source.knip.workspaces["${options.ownerName}"].ignoreFiles with a reason.`,
    ],
    ownerDirectory: options.ownerDirectory,
    ownerName: options.ownerName,
    packageJsonPath: options.packageJsonPath,
    reason:
      'Owner-governed source modules must be reachable from package entries, binaries, scripts, or Knip plugin entries.',
    summary: 'Unused source module is not reachable from package entry points.',
    task: 'source:check',
    title: 'Unused source module',
    tool: 'knip',
    verifyCommands: ['limina source check'],
  };
}

export function createSourceUnusedWorkspaceDependencyFinding(options: {
  dependencyName: string;
  externalCode: string;
  externalMessage?: string;
  ownerName: string;
  packageJsonPath: string;
  sectionName: string;
  specifier: string;
}): SourceUnusedWorkspaceDependencyFinding {
  return {
    code: LIMINA_CHECK_ISSUE_CODES.sourceUnusedWorkspaceDependency,
    dependencyName: options.dependencyName,
    detector: 'knip',
    evidence: [
      {
        label: 'dependency',
        value: `${options.dependencyName} (${options.sectionName}: ${options.specifier})`,
      },
    ],
    external: {
      code: options.externalCode,
      message: options.externalMessage,
      tool: 'knip',
    },
    facts: {
      dependencyName: options.dependencyName,
      kind: 'unused-workspace-dependency',
      packageManifestPath: options.packageJsonPath,
      packageName: options.ownerName,
      sectionName: options.sectionName,
      specifier: options.specifier,
    },
    fixSteps: [
      'Remove dependencies that are truly unused from the package manifest.',
      'Make dependencies reachable from package entries, binaries, scripts, or Knip plugin entries.',
      `Add intentional dependencies to source.knip.workspaces["${options.ownerName}"].ignoreDependencies with dep and reason.`,
    ],
    ownerName: options.ownerName,
    packageJsonPath: options.packageJsonPath,
    reason:
      'Workspace package dependencies must be reachable from package entries, binaries, scripts, or explicitly ignored when usage is not visible to Knip analysis.',
    sectionName: options.sectionName,
    specifier: options.specifier,
    summary: 'Workspace package dependency is not visible to source analysis.',
    task: 'source:check',
    title: 'Unused workspace dependency',
    tool: 'knip',
    verifyCommands: ['limina source check'],
  };
}

export function createSourceCheckIssueFromFinding(options: {
  finding: SourceFinding;
  rootDir: string;
}): CanonicalLiminaCheckIssue {
  return createLiminaCheckIssue({
    checkerName: options.finding.checkerName,
    code: options.finding.code,
    detailLines: options.finding.detailLines,
    detector: options.finding.detector,
    domain: 'source',
    evidence: options.finding.evidence,
    external: options.finding.external,
    filePath: options.finding.filePath,
    fix: options.finding.fix,
    fixSteps: options.finding.fixSteps,
    locations: options.finding.locations,
    packageManifestPath: options.finding.packageJsonPath,
    packageName: options.finding.ownerName,
    reason: options.finding.reason,
    rootDir: options.rootDir,
    scope: options.finding.scope,
    summary: options.finding.summary,
    task: options.finding.task,
    title: options.finding.title,
    tool: options.finding.tool,
    verifyCommands: options.finding.verifyCommands,
  });
}
