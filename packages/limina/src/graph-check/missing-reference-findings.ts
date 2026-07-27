import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  formatImportRecordLocation,
  type ImportRecord,
  type ProjectInfo,
} from '#core/import-graph/context';
import { formatReferences } from '#core/tsconfig/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import { createGraphImportFact, getProjectCheckerName } from './finding-utils';
import type {
  GraphFinding,
  GraphImportFact,
  GraphReferenceMissingFinding,
} from './findings';
import {
  getGeneratedCheckerNamespace,
  getGeneratedSourceConfigPath,
} from './generated-project-paths';
import type { ReferenceExpectation } from './reference-types';

function formatImportRecordLines(
  config: ResolvedLiminaConfig,
  importRecords: ImportRecord[],
): string[] {
  const lines = importRecords
    .slice(0, 5)
    .map(
      (importRecord) =>
        `    - ${formatImportRecordLocation(config.rootDir, importRecord)} imports ${importRecord.specifier}`,
    );

  return importRecords.length > 5
    ? [...lines, `    ...and ${importRecords.length - 5} more`]
    : lines;
}

interface ProviderEdgeIdentity {
  fromChecker: string;
  fromConfigPath: string;
  toChecker: string;
  toConfigPath: string;
}

function createProviderEdgeIdentity(options: {
  expectation: ReferenceExpectation;
  fromProjectPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
}): ProviderEdgeIdentity | null {
  const identity = {
    fromChecker: getGeneratedCheckerNamespace(options.fromProjectPath),
    fromConfigPath: getGeneratedSourceConfigPath(
      options.generatedGraph,
      options.fromProjectPath,
    ),
    toChecker: getGeneratedCheckerNamespace(
      options.expectation.targetProjectPath,
    ),
    toConfigPath: getGeneratedSourceConfigPath(
      options.generatedGraph,
      options.expectation.targetProjectPath,
    ),
  };

  if (Object.values(identity).some((value) => !value)) {
    return null;
  }

  return identity as ProviderEdgeIdentity;
}

function matchesProviderEdge(
  edge: GeneratedTsconfigGraphResult['providerEdges'][number],
  identity: ProviderEdgeIdentity,
): boolean {
  return [
    edge.fromChecker === identity.fromChecker,
    edge.toChecker === identity.toChecker,
    edge.fromConfigPath === identity.fromConfigPath,
    edge.toConfigPath === identity.toConfigPath,
  ].every(Boolean);
}

function hasProviderEdgeForReferenceExpectation(options: {
  expectation: ReferenceExpectation;
  fromProjectPath: string;
  generatedGraph: GeneratedTsconfigGraphResult;
}): boolean {
  const identity = createProviderEdgeIdentity(options);
  if (!identity) {
    return false;
  }

  return options.generatedGraph.providerEdges.some((edge) =>
    matchesProviderEdge(edge, identity),
  );
}

function isExpectedReferenceSatisfied(options: {
  expectation: ReferenceExpectation;
  generatedGraph: GeneratedTsconfigGraphResult;
  project: ProjectInfo;
}): boolean {
  if (options.project.references.has(options.expectation.targetProjectPath)) {
    return true;
  }

  return hasProviderEdgeForReferenceExpectation({
    expectation: options.expectation,
    fromProjectPath: options.project.configPath,
    generatedGraph: options.generatedGraph,
  });
}

function createMissingReferenceFinding(options: {
  config: ResolvedLiminaConfig;
  expectation: ReferenceExpectation;
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
}): GraphReferenceMissingFinding {
  const importFacts = options.expectation.importRecords.map(
    createGraphImportFact,
  );
  const detailLines = [
    'Missing project reference for workspace import:',
    `  importing project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  expected reference: ${toRelativePath(options.config.rootDir, options.expectation.targetProjectPath)}`,
    `  current references: ${formatReferences(options.config.rootDir, options.project.references)}`,
    '  imports:',
    ...formatImportRecordLines(
      options.config,
      options.expectation.importRecords,
    ),
    '  fix: ensure both source tsconfig files are selected by checker.include, then run `limina graph prepare`.',
  ];

  return {
    checkerName: getProjectCheckerName(
      options.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphReferenceMissing,
    evidence: [
      {
        label: 'expected reference',
        value: options.expectation.targetProjectPath,
      },
      {
        label: 'imports',
        lines: importFacts.map(
          (fact) =>
            `${fact.filePath}:${fact.line} (${fact.kind}) imports ${fact.specifier}`,
        ),
      },
    ],
    facts: {
      expectedReferencePath: options.expectation.targetProjectPath,
      imports: importFacts,
      projectPath: options.project.configPath,
    },
    filePath: options.project.configPath,
    locations: [
      { filePath: options.project.configPath, label: 'importing project' },
      {
        filePath: options.expectation.targetProjectPath,
        label: 'expected reference',
      },
      ...importFacts.map((fact: GraphImportFact) => ({
        filePath: fact.filePath,
        label: 'import',
        line: fact.line,
      })),
    ],
    presentation: {
      detailLines,
      fix: 'Ensure both source tsconfig files are selected by checker.include, then run `limina graph prepare`.',
      reason:
        'A static workspace import reaches a declaration project that is not listed in the source declaration references.',
      title: 'Missing project reference for workspace import',
    },
    task: 'graph:check',
  };
}

function checkMissingExpectation(options: {
  config: ResolvedLiminaConfig;
  expectation: ReferenceExpectation;
  findings: GraphFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
}): void {
  if (isExpectedReferenceSatisfied(options)) {
    return;
  }

  options.findings.push(createMissingReferenceFinding(options));
}

export function addMissingReferencesForProject(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  expectedReferences: Map<string, ReferenceExpectation>;
  findings: GraphFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
}): void {
  const expectations = [...options.expectedReferences.values()].sort(
    (left, right) =>
      left.targetProjectPath.localeCompare(right.targetProjectPath),
  );

  for (const expectation of expectations) {
    options.checks.add();
    checkMissingExpectation({ ...options, expectation });
  }
}
