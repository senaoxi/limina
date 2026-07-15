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

import type { CheckCounter } from '../check-reporting/stats';

interface CustomConditionSubtreeSummary {
  consistentConditions: string[] | null;
  mismatchProblems: string[];
  projectPaths: Set<string>;
}

export interface CustomConditionConsistencyContext {
  conditionsByProjectPath: Map<string, string[]>;
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
      mismatchProblems: [],
      projectPaths: new Set([project.configPath]),
    };
  }

  context.visitingProjectPaths.add(project.configPath);

  const mismatchProblems: string[] = [];
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

    mismatchProblems.push(...referencedSummary.mismatchProblems);

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

    mismatchProblems.push(
      [
        'Custom conditions mismatch in declaration reference tree:',
        `  root project: ${toRelativePath(config.rootDir, project.configPath)}`,
        `  referenced project: ${toRelativePath(
          config.rootDir,
          referencedProject.configPath,
        )}`,
        `  expected customConditions: ${formatCustomConditions(projectConditions)}`,
        `  actual customConditions: ${formatCustomConditions(referencedConditions)}`,
        '  reason: every tsconfig*.dts.json project reachable from a declaration leaf must use the same effective compilerOptions.customConditions.',
      ].join('\n'),
    );
  }

  context.visitingProjectPaths.delete(project.configPath);

  const summary: CustomConditionSubtreeSummary = {
    consistentConditions:
      mismatchProblems.length === 0 ? projectConditions : null,
    mismatchProblems,
    projectPaths,
  };

  context.subtreeByProjectPath.set(project.configPath, summary);

  return summary;
}

export function createCustomConditionConsistencyContext(
  projectsByPath: Map<string, ProjectInfo>,
): CustomConditionConsistencyContext {
  return {
    conditionsByProjectPath: new Map(),
    projectsByPath,
    subtreeByProjectPath: new Map(),
    visitingProjectPaths: new Set(),
  };
}

function addUniqueProblems(
  problems: string[],
  seenProblems: Set<string>,
  nextProblems: readonly string[],
): void {
  for (const problem of nextProblems) {
    if (seenProblems.has(problem) || problems.includes(problem)) {
      continue;
    }

    seenProblems.add(problem);
    problems.push(problem);
  }
}

export function addDefaultCustomConditionProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  consistencyContext: CustomConditionConsistencyContext;
  problems: string[];
  projects: ProjectInfo[];
}): void {
  const seenProblems = new Set<string>();

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

    addUniqueProblems(options.problems, seenProblems, summary.mismatchProblems);
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
  field: string;
  problems: string[];
  reason: string;
  value?: unknown;
}): void {
  options.problems.push(
    [
      'Invalid graph condition domain config:',
      `  field: ${options.field}`,
      ...(Object.hasOwn(options, 'value')
        ? [`  value: ${formatUnknownValue(options.value)}`]
        : []),
      `  reason: ${options.reason}`,
    ].join('\n'),
  );
}

function parseConditionDomainEntry(options: {
  domain: unknown;
  index: number;
  problems: string[];
}): { customConditions: string[]; entry: string; name: string } | null {
  const field = `graph.conditionDomains[${options.index}]`;

  if (!isPlainRecord(options.domain)) {
    addConditionDomainShapeProblem({
      field,
      problems: options.problems,
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
      field: `${field}.name`,
      problems: options.problems,
      reason: 'condition domain name must be a non-empty string.',
      value: name,
    });
    return null;
  }

  if (typeof entry !== 'string' || entry.trim().length === 0) {
    addConditionDomainShapeProblem({
      field: `${field}.entry`,
      problems: options.problems,
      reason:
        'condition domain entry must be a non-empty config-root-relative source tsconfig path.',
      value: entry,
    });
    return null;
  }

  if (path.isAbsolute(entry)) {
    addConditionDomainShapeProblem({
      field: `${field}.entry`,
      problems: options.problems,
      reason: 'condition domain entry must be relative to config.rootDir.',
      value: entry,
    });
    return null;
  }

  if (!Array.isArray(customConditions)) {
    addConditionDomainShapeProblem({
      field: `${field}.customConditions`,
      problems: options.problems,
      reason: 'condition domain customConditions must be an array of strings.',
      value: customConditions,
    });
    return null;
  }

  const parsedCustomConditions: string[] = [];

  for (const [conditionIndex, condition] of customConditions.entries()) {
    if (typeof condition !== 'string') {
      addConditionDomainShapeProblem({
        field: `${field}.customConditions[${conditionIndex}]`,
        problems: options.problems,
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

export function addConditionDomainProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  consistencyContext: CustomConditionConsistencyContext;
  generatedGraph: GeneratedTsconfigGraphResult;
  problems: string[];
  projectsByPath: Map<string, ProjectInfo>;
}): void {
  const domains = options.config.graph?.conditionDomains;

  if (domains === undefined) {
    return;
  }

  if (!Array.isArray(domains)) {
    addConditionDomainShapeProblem({
      field: 'graph.conditionDomains',
      problems: options.problems,
      reason: 'conditionDomains must be an array of condition domain objects.',
      value: domains,
    });
    return;
  }

  const seenSubtreeProblems = new Set<string>();

  for (const [index, domain] of domains.entries()) {
    options.checks.add();

    const normalizedDomain = parseConditionDomainEntry({
      domain,
      index,
      problems: options.problems,
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
      options.problems.push(
        [
          'Graph condition domain entry does not exist:',
          `  domain: ${normalizedDomain.name}`,
          `  entry: ${normalizedDomain.entry}`,
          `  resolved: ${toRelativePath(options.config.rootDir, configuredEntryPath)}`,
          '  reason: condition domain entries must point to an existing source tsconfig or generated declaration project.',
        ].join('\n'),
      );
      continue;
    }

    if (!isDtsProjectConfig(entryPath)) {
      options.problems.push(
        [
          'Graph condition domain entry is not a declaration project:',
          `  domain: ${normalizedDomain.name}`,
          `  entry: ${normalizedDomain.entry}`,
          `  resolved: ${toRelativePath(options.config.rootDir, entryPath)}`,
          '  reason: condition domain entries must point to source tsconfig paths that map to generated declaration projects.',
        ].join('\n'),
      );
      continue;
    }

    const entryProject = options.projectsByPath.get(entryPath);

    if (!entryProject) {
      options.problems.push(
        [
          'Graph condition domain entry is not reachable from checker entries:',
          `  domain: ${normalizedDomain.name}`,
          `  entry: ${normalizedDomain.entry}`,
          `  resolved: ${toRelativePath(options.config.rootDir, entryPath)}`,
          '  reason: condition domain entries must point to source tsconfig paths governed by the active Limina checker entries.',
        ].join('\n'),
      );
      continue;
    }

    const summary = collectCustomConditionSubtreeSummary(
      options.config,
      entryProject,
      options.consistencyContext,
    );

    addUniqueProblems(
      options.problems,
      seenSubtreeProblems,
      summary.mismatchProblems,
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

    options.problems.push(
      [
        'Graph condition domain customConditions mismatch:',
        `  domain: ${normalizedDomain.name}`,
        `  entry: ${toRelativePath(options.config.rootDir, entryPath)}`,
        `  expected customConditions: ${formatCustomConditions(normalizedDomain.customConditions)}`,
        `  actual customConditions: ${formatCustomConditions(entryConditions)}`,
        '  reason: a condition domain declares the bundler/package resolution conditions for its declaration reference tree, so the entry project must use the same effective compilerOptions.customConditions.',
      ].join('\n'),
    );
  }
}
