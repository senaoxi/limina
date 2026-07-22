import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'pathe';

import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import { uniqueSortedStrings } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';

import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { CheckCounter } from '../check-reporting/stats';
import type {
  GraphConditionDomainMismatchFinding,
  GraphConfigInvalidFinding,
  GraphFinding,
} from './findings';

interface CustomConditionSubtreeSummary {
  consistentConditions: string[] | null;
  mismatchFindings: GraphConditionDomainMismatchFinding[];
  projectPaths: Set<string>;
}

export interface CustomConditionConsistencyContext {
  conditionsByProjectPath: Map<string, string[]>;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projectsByPath: Map<string, ProjectInfo>;
  subtreeByProjectPath: Map<string, CustomConditionSubtreeSummary>;
  visitingProjectPaths: Set<string>;
}

function normalizeCustomConditions(
  value: readonly string[] | undefined,
): string[] {
  if (!value) {
    return [];
  }

  return uniqueSortedStrings(value);
}

function getProjectCustomConditions(project: ProjectInfo): string[] {
  return normalizeCustomConditions(project.options.customConditions);
}

function formatCustomConditions(conditions: readonly string[]): string {
  return JSON.stringify(conditions);
}

function customConditionsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return isDeepStrictEqual(left, right);
}

function createGeneratedGraphPathAliases(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, string> {
  return new Map(
    [...generatedGraph.sourceToDts.values()].flatMap((sourceToDts) => [
      ...sourceToDts.entries(),
    ]),
  );
}

function collectCustomConditionSubtreeSummary(
  config: ResolvedLiminaConfig,
  project: ProjectInfo,
  context: CustomConditionConsistencyContext,
): CustomConditionSubtreeSummary {
  const cached = context.subtreeByProjectPath.get(project.configPath);

  if (cached) {
    return cached;
  }

  const projectConditions =
    context.conditionsByProjectPath.get(project.configPath) ??
    getProjectCustomConditions(project);

  context.conditionsByProjectPath.set(project.configPath, projectConditions);

  if (context.visitingProjectPaths.has(project.configPath)) {
    return {
      consistentConditions: projectConditions,
      mismatchFindings: [],
      projectPaths: new Set([project.configPath]),
    };
  }

  context.visitingProjectPaths.add(project.configPath);

  const mismatchFindings: GraphConditionDomainMismatchFinding[] = [];
  const projectPaths = new Set([project.configPath]);

  for (const referencePath of [...project.references].sort()) {
    const referencedProject = context.projectsByPath.get(referencePath);

    if (
      !referencedProject ||
      !isDtsProjectConfig(referencedProject.configPath)
    ) {
      continue;
    }

    const referencedSummary = collectCustomConditionSubtreeSummary(
      config,
      referencedProject,
      context,
    );

    for (const projectPath of referencedSummary.projectPaths) {
      projectPaths.add(projectPath);
    }

    mismatchFindings.push(...referencedSummary.mismatchFindings);

    const referencedConditions =
      context.conditionsByProjectPath.get(referencedProject.configPath) ??
      getProjectCustomConditions(referencedProject);

    context.conditionsByProjectPath.set(
      referencedProject.configPath,
      referencedConditions,
    );

    if (customConditionsEqual(projectConditions, referencedConditions)) {
      continue;
    }

    const lines = [
      'Custom conditions mismatch in declaration reference tree:',
      `  root project: ${toRelativePath(config.rootDir, project.configPath)}`,
      `  referenced project: ${toRelativePath(
        config.rootDir,
        referencedProject.configPath,
      )}`,
      `  expected customConditions: ${formatCustomConditions(projectConditions)}`,
      `  actual customConditions: ${formatCustomConditions(referencedConditions)}`,
      '  reason: every tsconfig*.dts.json project reachable from a declaration leaf must use the same effective compilerOptions.customConditions.',
    ];

    mismatchFindings.push({
      checkerName: context.projectCheckerNamesByPath.get(project.configPath),
      code: LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch,
      evidence: [
        {
          label: 'expected customConditions',
          value: formatCustomConditions(projectConditions),
        },
        {
          label: 'actual customConditions',
          value: formatCustomConditions(referencedConditions),
        },
      ],
      facts: {
        actualConditions: referencedConditions,
        expectedConditions: projectConditions,
        kind: 'reference-tree',
        referencedProjectPath: referencedProject.configPath,
        rootProjectPath: project.configPath,
      },
      filePath: project.configPath,
      locations: [
        {
          filePath: project.configPath,
          label: 'root project',
        },
        {
          filePath: referencedProject.configPath,
          label: 'referenced project',
        },
      ],
      presentation: {
        detailLines: lines,
        reason:
          'every tsconfig*.dts.json project reachable from a declaration leaf must use the same effective compilerOptions.customConditions.',
        title: 'Custom conditions mismatch in declaration reference tree',
      },
      task: 'graph:check',
    });
  }

  context.visitingProjectPaths.delete(project.configPath);

  const summary: CustomConditionSubtreeSummary = {
    consistentConditions:
      mismatchFindings.length === 0 ? projectConditions : null,
    mismatchFindings,
    projectPaths,
  };

  context.subtreeByProjectPath.set(project.configPath, summary);

  return summary;
}

export function createCustomConditionConsistencyContext(
  projectsByPath: Map<string, ProjectInfo>,
  projectCheckerNamesByPath: ReadonlyMap<string, string> = new Map(),
): CustomConditionConsistencyContext {
  return {
    conditionsByProjectPath: new Map(),
    projectCheckerNamesByPath,
    projectsByPath,
    subtreeByProjectPath: new Map(),
    visitingProjectPaths: new Set(),
  };
}

function getConditionMismatchIdentity(
  finding: GraphConditionDomainMismatchFinding,
): string {
  return finding.facts.kind === 'reference-tree'
    ? `${finding.code}\0reference-tree\0${finding.facts.rootProjectPath}\0${finding.facts.referencedProjectPath}`
    : `${finding.code}\0domain-entry\0${finding.facts.domainName}\0${finding.facts.entryProjectPath}`;
}

function addUniqueFindings(
  findings: GraphFinding[],
  seenFindingIdentities: Set<string>,
  nextFindings: readonly GraphConditionDomainMismatchFinding[],
): void {
  for (const finding of nextFindings) {
    const identity = getConditionMismatchIdentity(finding);

    if (seenFindingIdentities.has(identity)) {
      continue;
    }

    seenFindingIdentities.add(identity);
    findings.push(finding);
  }
}

export function addDefaultCustomConditionProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  consistencyContext: CustomConditionConsistencyContext;
  findings: GraphFinding[];
  projects: ProjectInfo[];
}): void {
  const seenFindingIdentities = new Set<string>();

  for (const project of options.projects) {
    if (!isDtsProjectConfig(project.configPath)) {
      continue;
    }

    options.checks.add();

    const summary = collectCustomConditionSubtreeSummary(
      options.config,
      project,
      options.consistencyContext,
    );

    addUniqueFindings(
      options.findings,
      seenFindingIdentities,
      summary.mismatchFindings,
    );
  }
}

function getConditionDomainEntryPath(options: {
  config: ResolvedLiminaConfig;
  entry: string;
}): string {
  return normalizeAbsolutePath(
    path.resolve(options.config.rootDir, options.entry),
  );
}

function addConditionDomainShapeProblem(options: {
  config: ResolvedLiminaConfig;
  field: string;
  findings: GraphFinding[];
  reason: string;
  value?: unknown;
}): void {
  const lines = [
    'Invalid graph condition domain config:',
    `  field: ${options.field}`,
    ...(Object.hasOwn(options, 'value')
      ? [`  value: ${formatUnknownValue(options.value)}`]
      : []),
    `  reason: ${options.reason}`,
  ];

  options.findings.push({
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      {
        label: 'field',
        value: options.field,
      },
      ...(Object.hasOwn(options, 'value')
        ? [
            {
              label: 'value',
              value: formatUnknownValue(options.value),
            },
          ]
        : []),
    ],
    facts: {
      configPath: options.config.configPath,
      field: options.field,
      kind: 'condition-domain',
    },
    filePath: options.config.configPath,
    locations: [
      {
        filePath: options.config.configPath,
        label: 'Limina config',
      },
    ],
    presentation: {
      detailLines: lines,
      reason: options.reason,
      title: 'Invalid graph condition domain config',
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}

function parseConditionDomainEntry(options: {
  config: ResolvedLiminaConfig;
  domain: unknown;
  findings: GraphFinding[];
  index: number;
}): { customConditions: string[]; entry: string; name: string } | null {
  const field = `graph.conditionDomains[${options.index}]`;

  if (!isPlainRecord(options.domain)) {
    addConditionDomainShapeProblem({
      config: options.config,
      field,
      findings: options.findings,
      reason:
        'condition domain entries must be objects with non-empty name and entry fields and a customConditions array.',
      value: options.domain,
    });
    return null;
  }

  const name = options.domain.name;
  const entry = options.domain.entry;
  const customConditions = options.domain.customConditions;

  if (typeof name !== 'string' || name.trim().length === 0) {
    addConditionDomainShapeProblem({
      config: options.config,
      field: `${field}.name`,
      findings: options.findings,
      reason: 'condition domain name must be a non-empty string.',
      value: name,
    });
    return null;
  }

  if (typeof entry !== 'string' || entry.trim().length === 0) {
    addConditionDomainShapeProblem({
      config: options.config,
      field: `${field}.entry`,
      findings: options.findings,
      reason:
        'condition domain entry must be a non-empty config-root-relative source tsconfig path.',
      value: entry,
    });
    return null;
  }

  if (path.isAbsolute(entry)) {
    addConditionDomainShapeProblem({
      config: options.config,
      field: `${field}.entry`,
      findings: options.findings,
      reason: 'condition domain entry must be relative to config.rootDir.',
      value: entry,
    });
    return null;
  }

  if (!Array.isArray(customConditions)) {
    addConditionDomainShapeProblem({
      config: options.config,
      field: `${field}.customConditions`,
      findings: options.findings,
      reason: 'condition domain customConditions must be an array of strings.',
      value: customConditions,
    });
    return null;
  }

  const parsedCustomConditions: string[] = [];

  for (const [conditionIndex, condition] of customConditions.entries()) {
    if (typeof condition !== 'string') {
      addConditionDomainShapeProblem({
        config: options.config,
        field: `${field}.customConditions[${conditionIndex}]`,
        findings: options.findings,
        reason: 'condition domain customConditions entries must be strings.',
        value: condition,
      });
      return null;
    }

    parsedCustomConditions.push(condition);
  }

  return {
    customConditions: normalizeCustomConditions(parsedCustomConditions),
    entry: entry.trim(),
    name: name.trim(),
  };
}

function addConditionDomainEntryProblem(options: {
  config: ResolvedLiminaConfig;
  domainName: string;
  entryPath: string;
  entryValue: string;
  findings: GraphFinding[];
  reason: string;
  title: string;
}): void {
  const lines = [
    `${options.title}:`,
    `  domain: ${options.domainName}`,
    `  entry: ${options.entryValue}`,
    `  resolved: ${toRelativePath(options.config.rootDir, options.entryPath)}`,
    `  reason: ${options.reason}`,
  ];

  options.findings.push({
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      {
        label: 'condition domain',
        value: options.domainName,
      },
      {
        label: 'resolved entry',
        value: options.entryPath,
      },
    ],
    facts: {
      configPath: options.config.configPath,
      field: 'graph.conditionDomains',
      kind: 'condition-domain',
    },
    filePath: options.entryPath,
    locations: [
      {
        filePath: options.config.configPath,
        label: 'Limina config',
      },
      {
        filePath: options.entryPath,
        label: 'condition domain entry',
      },
    ],
    presentation: {
      detailLines: lines,
      reason: options.reason,
      title: options.title,
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}

export function addConditionDomainProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  consistencyContext: CustomConditionConsistencyContext;
  generatedGraph: GeneratedTsconfigGraphResult;
  findings: GraphFinding[];
  projectsByPath: Map<string, ProjectInfo>;
}): void {
  const domains = options.config.graph?.conditionDomains;

  if (domains === undefined) {
    return;
  }

  if (!Array.isArray(domains)) {
    addConditionDomainShapeProblem({
      config: options.config,
      field: 'graph.conditionDomains',
      findings: options.findings,
      reason: 'conditionDomains must be an array of condition domain objects.',
      value: domains,
    });
    return;
  }

  const seenSubtreeFindingIdentities = new Set<string>();

  for (const [index, domain] of domains.entries()) {
    options.checks.add();

    const normalizedDomain = parseConditionDomainEntry({
      config: options.config,
      domain,
      findings: options.findings,
      index,
    });

    if (!normalizedDomain) {
      continue;
    }

    const configuredEntryPath = getConditionDomainEntryPath({
      config: options.config,
      entry: normalizedDomain.entry,
    });
    const entryPath =
      createGeneratedGraphPathAliases(options.generatedGraph).get(
        configuredEntryPath,
      ) ?? configuredEntryPath;

    if (
      !existsSync(configuredEntryPath) &&
      !options.generatedGraph.generatedFiles.has(
        normalizeAbsolutePath(configuredEntryPath),
      )
    ) {
      addConditionDomainEntryProblem({
        config: options.config,
        domainName: normalizedDomain.name,
        entryPath: configuredEntryPath,
        entryValue: normalizedDomain.entry,
        findings: options.findings,
        reason:
          'condition domain entries must point to an existing source tsconfig or generated declaration project.',
        title: 'Graph condition domain entry does not exist',
      });
      continue;
    }

    if (!isDtsProjectConfig(entryPath)) {
      addConditionDomainEntryProblem({
        config: options.config,
        domainName: normalizedDomain.name,
        entryPath,
        entryValue: normalizedDomain.entry,
        findings: options.findings,
        reason:
          'condition domain entries must point to source tsconfig paths that map to generated declaration projects.',
        title: 'Graph condition domain entry is not a declaration project',
      });
      continue;
    }

    const entryProject = options.projectsByPath.get(entryPath);

    if (!entryProject) {
      addConditionDomainEntryProblem({
        config: options.config,
        domainName: normalizedDomain.name,
        entryPath,
        entryValue: normalizedDomain.entry,
        findings: options.findings,
        reason:
          'condition domain entries must point to source tsconfig paths governed by the active Limina checker entries.',
        title:
          'Graph condition domain entry is not reachable from checker entries',
      });
      continue;
    }

    const summary = collectCustomConditionSubtreeSummary(
      options.config,
      entryProject,
      options.consistencyContext,
    );

    addUniqueFindings(
      options.findings,
      seenSubtreeFindingIdentities,
      summary.mismatchFindings,
    );

    const entryConditions =
      options.consistencyContext.conditionsByProjectPath.get(entryPath) ??
      getProjectCustomConditions(entryProject);

    options.consistencyContext.conditionsByProjectPath.set(
      entryPath,
      entryConditions,
    );

    if (
      customConditionsEqual(normalizedDomain.customConditions, entryConditions)
    ) {
      continue;
    }

    const lines = [
      'Graph condition domain customConditions mismatch:',
      `  domain: ${normalizedDomain.name}`,
      `  entry: ${toRelativePath(options.config.rootDir, entryPath)}`,
      `  expected customConditions: ${formatCustomConditions(normalizedDomain.customConditions)}`,
      `  actual customConditions: ${formatCustomConditions(entryConditions)}`,
      '  reason: a condition domain declares the bundler/package resolution conditions for its declaration reference tree, so the entry project must use the same effective compilerOptions.customConditions.',
    ];

    options.findings.push({
      checkerName:
        options.consistencyContext.projectCheckerNamesByPath.get(entryPath),
      code: LIMINA_CHECK_ISSUE_CODES.graphConditionDomainMismatch,
      evidence: [
        {
          label: 'expected customConditions',
          value: formatCustomConditions(normalizedDomain.customConditions),
        },
        {
          label: 'actual customConditions',
          value: formatCustomConditions(entryConditions),
        },
      ],
      facts: {
        actualConditions: entryConditions,
        domainName: normalizedDomain.name,
        entryProjectPath: entryPath,
        expectedConditions: normalizedDomain.customConditions,
        kind: 'domain-entry',
      },
      filePath: entryPath,
      locations: [
        {
          filePath: options.config.configPath,
          label: 'Limina config',
        },
        {
          filePath: entryPath,
          label: 'condition domain entry',
        },
      ],
      presentation: {
        detailLines: lines,
        reason:
          'a condition domain declares the bundler/package resolution conditions for its declaration reference tree, so the entry project must use the same effective compilerOptions.customConditions.',
        title: 'Graph condition domain customConditions mismatch',
      },
      task: 'graph:check',
    } satisfies GraphConditionDomainMismatchFinding);
  }
}
