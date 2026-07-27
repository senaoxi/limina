import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  isDtsProjectConfig,
  type ProjectInfo,
} from '#core/import-graph/context';
import { normalizeAbsolutePath } from '#utils/path';
import { existsSync } from 'node:fs';
import type { CheckCounter } from '../check-reporting/stats';
import {
  addConditionDomainEntryProblem,
  createGeneratedGraphPathAliases,
  getConditionDomainEntryPath,
  parseConditionDomainEntry,
  resolveConditionDomains,
} from './condition-domain-config';
import { createDomainMismatchFinding } from './condition-domain-finding';
import {
  addUniqueConditionFindings,
  collectCustomConditionSubtreeSummary,
  customConditionsEqual,
  getProjectCustomConditions,
} from './condition-subtree';
import type {
  CustomConditionConsistencyContext,
  ParsedConditionDomain,
} from './condition-types';
import type { GraphFinding } from './findings';

interface ConditionDomainContext {
  aliases: ReadonlyMap<string, string>;
  config: ResolvedLiminaConfig;
  consistencyContext: CustomConditionConsistencyContext;
  findings: GraphFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  projectsByPath: ReadonlyMap<string, ProjectInfo>;
  seenFindingIdentities: Set<string>;
}

interface ResolvedDomainEntry {
  domain: ParsedConditionDomain;
  entryPath: string;
  entryProject: ProjectInfo;
}

interface EntryCandidate {
  configuredEntryPath: string;
  domain: ParsedConditionDomain;
  entryPath: string;
}

interface EntryProblem {
  entryPath: string;
  reason: string;
  title: string;
}

type EntryValidator = (
  candidate: EntryCandidate,
  context: ConditionDomainContext,
) => EntryProblem | null;

function isConfiguredEntryPresent(
  candidate: EntryCandidate,
  context: ConditionDomainContext,
): boolean {
  return (
    existsSync(candidate.configuredEntryPath) ||
    context.generatedGraph.generatedFiles.has(
      normalizeAbsolutePath(candidate.configuredEntryPath),
    )
  );
}

const validateExistingEntry: EntryValidator = (candidate, context) =>
  isConfiguredEntryPresent(candidate, context)
    ? null
    : {
        entryPath: candidate.configuredEntryPath,
        reason:
          'condition domain entries must point to an existing source tsconfig or generated declaration project.',
        title: 'Graph condition domain entry does not exist',
      };

const validateDeclarationEntry: EntryValidator = (candidate) =>
  isDtsProjectConfig(candidate.entryPath)
    ? null
    : {
        entryPath: candidate.entryPath,
        reason:
          'condition domain entries must point to source tsconfig paths that map to generated declaration projects.',
        title: 'Graph condition domain entry is not a declaration project',
      };

const validateReachableEntry: EntryValidator = (candidate, context) =>
  context.projectsByPath.has(candidate.entryPath)
    ? null
    : {
        entryPath: candidate.entryPath,
        reason:
          'condition domain entries must point to source tsconfig paths governed by the active Limina checker entries.',
        title:
          'Graph condition domain entry is not reachable from checker entries',
      };

const entryValidators: readonly EntryValidator[] = [
  validateExistingEntry,
  validateDeclarationEntry,
  validateReachableEntry,
];

function findEntryProblem(
  candidate: EntryCandidate,
  context: ConditionDomainContext,
): EntryProblem | null {
  for (const validate of entryValidators) {
    const problem = validate(candidate, context);

    if (problem !== null) {
      return problem;
    }
  }

  return null;
}

function createEntryCandidate(
  domain: ParsedConditionDomain,
  context: ConditionDomainContext,
): EntryCandidate {
  const configuredEntryPath = getConditionDomainEntryPath({
    config: context.config,
    entry: domain.entry,
  });
  return {
    configuredEntryPath,
    domain,
    entryPath: context.aliases.get(configuredEntryPath) ?? configuredEntryPath,
  };
}

function addEntryProblem(
  candidate: EntryCandidate,
  problem: EntryProblem,
  context: ConditionDomainContext,
): void {
  addConditionDomainEntryProblem({
    config: context.config,
    domainName: candidate.domain.name,
    entryPath: problem.entryPath,
    entryValue: candidate.domain.entry,
    findings: context.findings,
    reason: problem.reason,
    title: problem.title,
  });
}

function resolveDomainEntry(
  domain: ParsedConditionDomain,
  context: ConditionDomainContext,
): ResolvedDomainEntry | null {
  const candidate = createEntryCandidate(domain, context);
  const problem = findEntryProblem(candidate, context);

  if (problem !== null) {
    addEntryProblem(candidate, problem, context);
    return null;
  }

  return {
    domain,
    entryPath: candidate.entryPath,
    entryProject: context.projectsByPath.get(candidate.entryPath)!,
  };
}

function addDomainMismatch(
  resolved: ResolvedDomainEntry,
  context: ConditionDomainContext,
): void {
  const summary = collectCustomConditionSubtreeSummary(
    context.config,
    resolved.entryProject,
    context.consistencyContext,
  );
  addUniqueConditionFindings(
    context.findings,
    context.seenFindingIdentities,
    summary.mismatchFindings,
  );
  const entryConditions = getProjectCustomConditions(resolved.entryProject);
  context.consistencyContext.conditionsByProjectPath.set(
    resolved.entryPath,
    entryConditions,
  );

  if (
    !customConditionsEqual(resolved.domain.customConditions, entryConditions)
  ) {
    context.findings.push(
      createDomainMismatchFinding({
        config: context.config,
        consistencyContext: context.consistencyContext,
        domain: resolved.domain,
        entryConditions,
        entryPath: resolved.entryPath,
      }),
    );
  }
}

function processConditionDomain(
  domainValue: unknown,
  index: number,
  context: ConditionDomainContext,
): void {
  const domain = parseConditionDomainEntry({
    config: context.config,
    domain: domainValue,
    findings: context.findings,
    index,
  });

  if (domain === null) {
    return;
  }

  const resolved = resolveDomainEntry(domain, context);

  if (resolved !== null) {
    addDomainMismatch(resolved, context);
  }
}

export function addConditionDomainProblems(options: {
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  consistencyContext: CustomConditionConsistencyContext;
  generatedGraph: GeneratedTsconfigGraphResult;
  findings: GraphFinding[];
  projectsByPath: Map<string, ProjectInfo>;
}): void {
  const domains = resolveConditionDomains(options.config, options.findings);

  if (domains === null) {
    return;
  }

  const context: ConditionDomainContext = {
    aliases: createGeneratedGraphPathAliases(options.generatedGraph),
    config: options.config,
    consistencyContext: options.consistencyContext,
    findings: options.findings,
    generatedGraph: options.generatedGraph,
    projectsByPath: options.projectsByPath,
    seenFindingIdentities: new Set(),
  };

  for (const [index, domain] of domains.entries()) {
    options.checks.add();
    processConditionDomain(domain, index, context);
  }
}
