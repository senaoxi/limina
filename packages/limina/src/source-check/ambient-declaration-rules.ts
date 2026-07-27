import type { ResolvedLiminaConfig } from '#config/runner';
import { toPosixPath, toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import {
  createCandidateGlobMatcher,
  type WorkspaceRegionFilePathIndex,
} from '../core/workspace/file-candidates';
import type {
  AmbientDeclarationRule,
  AmbientRuleMatch,
} from './ambient-declaration-types';
import type {
  SourceAmbientDeclarationConfigInvalidFacts,
  SourceFinding,
  SourceFindingForCode,
} from './findings';

function getOptionalDetails(details: string[] | undefined): string[] {
  return details === undefined ? [] : details;
}

function createIssueLines(options: {
  config: ResolvedLiminaConfig;
  details?: string[];
  filePath?: string;
  reason: string;
  rule: string;
}): string[] {
  const lines = [`rule: ${options.rule}`];

  if (options.filePath !== undefined) {
    lines.push(
      `file: ${toRelativePath(options.config.rootDir, options.filePath)}`,
    );
  }

  lines.push(
    ...getOptionalDetails(options.details),
    `reason: ${options.reason}`,
  );
  return lines;
}

function createOptionalFileField(
  filePath: string | undefined,
): { readonly filePath: string } | Record<string, never> {
  return filePath === undefined ? {} : { filePath };
}

export function createAmbientConfigIssue(options: {
  config: ResolvedLiminaConfig;
  details?: string[];
  facts: SourceAmbientDeclarationConfigInvalidFacts;
  filePath?: string;
  reason: string;
}): SourceFindingForCode<
  typeof LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid
> {
  const rule = options.facts.ruleIdentity;
  const lines = createIssueLines({
    config: options.config,
    details: options.details,
    filePath: options.filePath,
    reason: options.reason,
    rule,
  });
  return {
    code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid,
    detailLines: lines,
    detector: 'source',
    evidence: [{ label: 'diagnostic', lines }],
    facts: options.facts,
    ...createOptionalFileField(options.filePath),
    ownerName: '<workspace>',
    reason: options.reason,
    scope: rule,
    summary: 'Ambient declaration configuration is invalid',
    task: 'source:check',
    title: 'Ambient declaration configuration is invalid',
  };
}

function createRuleIdentity(ruleIndex: number): string {
  return `source.declarations.ambient[${ruleIndex}]`;
}

function createRuleMatch(options: {
  candidates: readonly string[];
  config: ResolvedLiminaConfig;
  rule: AmbientDeclarationRule;
  ruleIndex: number;
}): AmbientRuleMatch {
  const matches = createCandidateGlobMatcher(options.rule.include);

  return {
    matches: options.candidates.filter((filePath) =>
      matches(toPosixPath(toRelativePath(options.config.rootDir, filePath))),
    ),
    rule: options.rule,
    ruleIndex: options.ruleIndex,
  };
}

export function collectAmbientRuleMatches(options: {
  candidates: readonly string[];
  config: ResolvedLiminaConfig;
  rules: readonly AmbientDeclarationRule[];
  workspacePathIndex?: WorkspaceRegionFilePathIndex;
}): AmbientRuleMatch[] {
  return options.rules.map((rule, ruleIndex) =>
    createRuleMatch({
      candidates: options.candidates,
      config: options.config,
      rule,
      ruleIndex,
    }),
  );
}

function addFileRuleIndex(
  ruleIndexesByFile: Map<string, number[]>,
  filePath: string,
  ruleIndex: number,
): void {
  const indexes = ruleIndexesByFile.get(filePath) ?? [];
  indexes.push(ruleIndex);
  ruleIndexesByFile.set(filePath, indexes);
}

function indexRuleMatches(
  ruleIndexesByFile: Map<string, number[]>,
  ruleMatch: AmbientRuleMatch,
): void {
  for (const filePath of ruleMatch.matches) {
    addFileRuleIndex(ruleIndexesByFile, filePath, ruleMatch.ruleIndex);
  }
}

function createNoMatchIssue(
  config: ResolvedLiminaConfig,
  ruleMatch: AmbientRuleMatch,
): SourceFinding {
  return createAmbientConfigIssue({
    config,
    details: [`include: ${ruleMatch.rule.include.join(', ')}`],
    facts: {
      include: ruleMatch.rule.include,
      kind: 'no-matches',
      ruleIdentity: createRuleIdentity(ruleMatch.ruleIndex),
      ruleIndex: ruleMatch.ruleIndex,
    },
    reason:
      'ambient declaration rules must match at least one existing declaration file.',
  });
}

function appendNoMatchIssue(
  issues: SourceFinding[],
  config: ResolvedLiminaConfig,
  ruleMatch: AmbientRuleMatch,
): void {
  if (ruleMatch.matches.length === 0) {
    issues.push(createNoMatchIssue(config, ruleMatch));
  }
}

function formatMatchingRules(indexes: readonly number[]): string[] {
  return indexes.map(createRuleIdentity);
}

function createOverlapIssue(options: {
  config: ResolvedLiminaConfig;
  filePath: string;
  indexes: readonly number[];
  ruleIndex: number;
}): SourceFinding {
  const matchingRuleIdentities = formatMatchingRules(options.indexes);

  return createAmbientConfigIssue({
    config: options.config,
    details: [`matching rules: ${matchingRuleIdentities.join(', ')}`],
    facts: {
      declarationPath: options.filePath,
      kind: 'overlapping-rules',
      matchingRuleIdentities,
      ruleIdentity: createRuleIdentity(options.ruleIndex),
      ruleIndex: options.ruleIndex,
    },
    filePath: options.filePath,
    reason:
      'one physical declaration file cannot match multiple ambient declaration rules.',
  });
}

function appendOverlapIssues(options: {
  config: ResolvedLiminaConfig;
  filePath: string;
  indexes: readonly number[];
  issues: SourceFinding[];
  overlappingRules: Set<number>;
}): void {
  if (options.indexes.length <= 1) {
    return;
  }

  for (const ruleIndex of options.indexes) {
    options.overlappingRules.add(ruleIndex);
    options.issues.push(
      createOverlapIssue({
        config: options.config,
        filePath: options.filePath,
        indexes: options.indexes,
        ruleIndex,
      }),
    );
  }
}

export function collectAmbientRuleConfiguration(options: {
  config: ResolvedLiminaConfig;
  ruleMatches: readonly AmbientRuleMatch[];
}): { issues: SourceFinding[]; overlappingRules: Set<number> } {
  const issues: SourceFinding[] = [];
  const ruleIndexesByFile = new Map<string, number[]>();

  for (const ruleMatch of options.ruleMatches) {
    appendNoMatchIssue(issues, options.config, ruleMatch);
    indexRuleMatches(ruleIndexesByFile, ruleMatch);
  }

  const overlappingRules = new Set<number>();

  for (const [filePath, indexes] of ruleIndexesByFile) {
    appendOverlapIssues({
      config: options.config,
      filePath,
      indexes,
      issues,
      overlappingRules,
    });
  }

  return { issues, overlappingRules };
}
