import type { ResolvedLiminaConfig } from '#config/runner';
import type {
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from '#core/build-graph/runner';
import type { ProjectInfo } from '#core/import-graph/context';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { readOutputOptions } from '../core/build-graph/generated/config-readers';
import type { ManagedOutputProjectContext } from '../core/import-graph/managed-output-provider';
import type { WorkspaceExportsResolutionProfile } from '../core/workspace/exports';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { GraphConfigInvalidFinding, GraphFinding } from './findings';

export function filterProjectInfoToActivatedRegion(
  project: ProjectInfo,
  workspaceLookup: WorkspaceLookupIndex,
): ProjectInfo {
  return {
    ...project,
    fileNames: project.fileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
    ownedFileNames: project.ownedFileNames.filter((fileName) =>
      workspaceLookup.isInsideActivatedRegion(fileName),
    ),
  };
}

function getGovernedProjectPaths(unit: GovernedSourceUnit): string[] {
  const projection = unit.buildProjection;
  return [
    unit.configPath,
    'buildConfigPath' in projection ? projection.buildConfigPath : undefined,
    'dtsConfigPath' in projection ? projection.dtsConfigPath : undefined,
  ].filter((filePath): filePath is string => filePath !== undefined);
}

function registerFinalOwnedFileNames(options: {
  ownedByProjectPath: Map<string, ReadonlySet<string>>;
  unit: GovernedSourceUnit;
}): void {
  const ownedFileNames = new Set(options.unit.ownedFileNames);
  for (const projectPath of getGovernedProjectPaths(options.unit)) {
    options.ownedByProjectPath.set(projectPath, ownedFileNames);
  }
}

function createFinalOwnedFileNamesByProjectPath(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, ReadonlySet<string>> {
  const ownedByProjectPath = new Map<string, ReadonlySet<string>>();
  for (const sources of generatedGraph.governedSources.values()) {
    for (const unit of sources.values()) {
      registerFinalOwnedFileNames({ ownedByProjectPath, unit });
    }
  }
  return ownedByProjectPath;
}

export function alignProjectOwnedFilesWithGeneratedGraph(options: {
  generatedGraph: GeneratedTsconfigGraphResult;
  projects: readonly ProjectInfo[];
}): ProjectInfo[] {
  const ownedByProjectPath = createFinalOwnedFileNamesByProjectPath(
    options.generatedGraph,
  );
  return options.projects.map((project) => {
    const finalOwnedFileNames = ownedByProjectPath.get(project.configPath);
    if (finalOwnedFileNames === undefined) return project;
    return {
      ...project,
      ownedFileNames: project.ownedFileNames.filter((fileName) =>
        finalOwnedFileNames.has(fileName),
      ),
    };
  });
}

export function createWorkspaceExportsResolutionProfiles(
  projects: ProjectInfo[],
): WorkspaceExportsResolutionProfile[] {
  return projects.map((project) => ({
    checkerPresets: project.checkerPresets,
    configPath: project.configPath,
    extensions: project.extensions,
    options: project.options,
    resolverConfigPath: project.resolverConfigPath,
  }));
}

function createDiagnosticEvidence(
  diagnostic: ReturnType<typeof readOutputOptions>['diagnostics'][number],
) {
  const evidence = [{ label: 'field', value: diagnostic.field }];

  if (Object.hasOwn(diagnostic, 'value')) {
    evidence.push({ label: 'value', value: JSON.stringify(diagnostic.value) });
  }

  return evidence;
}

function addOutputOptionDiagnostics(options: {
  checkerName: string;
  diagnostics: ReturnType<typeof readOutputOptions>['diagnostics'];
  findings: GraphFinding[];
}): void {
  for (const diagnostic of options.diagnostics) {
    options.findings.push({
      checkerName: options.checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
      evidence: createDiagnosticEvidence(diagnostic),
      facts: {
        kind: 'output-options',
        projectPath: diagnostic.sourceConfigPath,
      },
      filePath: diagnostic.sourceConfigPath,
      locations: [
        { filePath: diagnostic.sourceConfigPath, label: 'source config' },
      ],
      presentation: {
        detailLines: diagnostic.detailLines,
        reason: diagnostic.reason,
        title: 'Invalid Limina output options',
      },
      task: 'graph:check',
    } satisfies GraphConfigInvalidFinding);
  }
}

function setManagedOutputContext(options: {
  checkerName: string;
  contextsByKey: Map<string, ManagedOutputProjectContext>;
  outputOptions: NonNullable<ReturnType<typeof readOutputOptions>['outputs']>;
  project: ProjectInfo;
}): void {
  const key = JSON.stringify([
    options.checkerName,
    options.project.resolverConfigPath,
  ]);
  if (options.contextsByKey.has(key)) {
    return;
  }

  options.contextsByKey.set(key, {
    checkerName: options.checkerName,
    sourceConfigPath: options.project.resolverConfigPath,
    outputOptions: {
      outDir: options.outputOptions.outDir,
      rootDir: options.outputOptions.rootDir,
    },
    ownedFileNames: options.project.ownedFileNames,
    extensions: options.project.extensions,
  });
}

function addManagedOutputProjectContext(options: {
  config: ResolvedLiminaConfig;
  contextsByKey: Map<string, ManagedOutputProjectContext>;
  findings: GraphFinding[];
  project: ProjectInfo;
  projectCheckerNamesByPath: Map<string, string>;
}): void {
  const checkerName = options.projectCheckerNamesByPath.get(
    options.project.configPath,
  );
  if (!checkerName) {
    return;
  }

  const outputOptions = readOutputOptions(
    options.config,
    options.project.resolverConfigPath,
  );
  addOutputOptionDiagnostics({
    checkerName,
    diagnostics: outputOptions.diagnostics,
    findings: options.findings,
  });
  if (!outputOptions.outputs) {
    return;
  }

  setManagedOutputContext({
    checkerName,
    contextsByKey: options.contextsByKey,
    outputOptions: outputOptions.outputs,
    project: options.project,
  });
}

export function createGraphCheckManagedOutputProjectContexts(options: {
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  projectCheckerNamesByPath: Map<string, string>;
  projects: ProjectInfo[];
}): ManagedOutputProjectContext[] {
  const contextsByKey = new Map<string, ManagedOutputProjectContext>();

  for (const project of options.projects) {
    addManagedOutputProjectContext({ ...options, contextsByKey, project });
  }

  return [...contextsByKey.values()];
}

export function createGeneratedGraphPathAliases(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, string> {
  return new Map(
    [...generatedGraph.sourceToDts.values()].flatMap((sourceToDts) => [
      ...sourceToDts.entries(),
    ]),
  );
}
