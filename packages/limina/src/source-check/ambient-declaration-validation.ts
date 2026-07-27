import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { collectWorkspacePackageDeclarationEntryPaths } from '../core/workspace/exports';
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
import {
  validateAmbientRole,
  validateDeclarationExtension,
} from './ambient-declaration-role';
import { createAmbientConfigIssue } from './ambient-declaration-rules';
import type {
  AmbientDeclarationPolicy,
  AmbientDeclarationViolation,
  AmbientRuleMatch,
} from './ambient-declaration-types';
import type { SourceFinding } from './findings';

interface DeclarationValidationContext {
  config: ResolvedLiminaConfig;
  liminaDir: string;
  managedPaths: ReadonlySet<string>;
  outputDirs: readonly string[];
  publicEntries: ReadonlySet<string>;
}

interface RulePolicyResult {
  issues: SourceFinding[];
  policies: AmbientDeclarationPolicy[];
}

type DeclarationValidator = (
  filePath: string,
  context: DeclarationValidationContext,
) => Promise<AmbientDeclarationViolation | null>;

function collectManagedDeclarationPaths(
  graph: GeneratedTsconfigGraphResult,
): Set<string> {
  return new Set(
    [...graph.dtsToSource.values()].flatMap((mapping) =>
      [...mapping.keys()].map(normalizeAbsolutePath),
    ),
  );
}

function isInsideOutputDirectory(
  filePath: string,
  outputDirs: readonly string[],
): boolean {
  return outputDirs.some((directory) =>
    isPathInsideDirectory(filePath, directory),
  );
}

function isManagedDeclaration(
  filePath: string,
  context: DeclarationValidationContext,
): boolean {
  return [
    isPathInsideDirectory(filePath, context.liminaDir),
    isInsideOutputDirectory(filePath, context.outputDirs),
    context.managedPaths.has(filePath),
  ].some(Boolean);
}

async function validateManagedDeclaration(
  filePath: string,
  context: DeclarationValidationContext,
): Promise<AmbientDeclarationViolation | null> {
  if (!isManagedDeclaration(filePath, context)) {
    return null;
  }

  return {
    kind: 'managed-output',
    reason:
      'managed output declarations cannot be classified as ambient declarations.',
  };
}

async function validatePublicEntry(
  filePath: string,
  context: DeclarationValidationContext,
): Promise<AmbientDeclarationViolation | null> {
  if (!context.publicEntries.has(filePath)) {
    return null;
  }

  return {
    kind: 'public-declaration-entry',
    reason:
      'workspace package public declaration entries cannot be classified as ambient declarations.',
  };
}

const declarationValidators: readonly DeclarationValidator[] = [
  validateDeclarationExtension,
  validateManagedDeclaration,
  validatePublicEntry,
  validateAmbientRole,
];

async function findDeclarationViolation(
  filePath: string,
  context: DeclarationValidationContext,
): Promise<AmbientDeclarationViolation | null> {
  for (const validate of declarationValidators) {
    const violation = await validate(filePath, context);

    if (violation !== null) {
      return violation;
    }
  }

  return null;
}

function createInvalidDeclarationIssue(options: {
  config: ResolvedLiminaConfig;
  filePath: string;
  ruleIndex: number;
  violation: AmbientDeclarationViolation;
}): SourceFinding {
  return createAmbientConfigIssue({
    config: options.config,
    facts: {
      declarationPath: options.filePath,
      kind: 'invalid-declaration',
      ruleIdentity: `source.declarations.ambient[${options.ruleIndex}]`,
      ruleIndex: options.ruleIndex,
      violation: options.violation.kind,
    },
    filePath: options.filePath,
    reason: options.violation.reason,
  });
}

async function collectRuleIssues(
  ruleMatch: AmbientRuleMatch,
  context: DeclarationValidationContext,
): Promise<SourceFinding[]> {
  const issues: SourceFinding[] = [];

  for (const filePath of ruleMatch.matches) {
    const violation = await findDeclarationViolation(filePath, context);

    if (violation !== null) {
      issues.push(
        createInvalidDeclarationIssue({
          config: context.config,
          filePath,
          ruleIndex: ruleMatch.ruleIndex,
          violation,
        }),
      );
    }
  }

  return issues;
}

function resolvePolicyFlag(value: boolean | undefined): boolean {
  return value === undefined ? false : value;
}

function createRulePolicies(
  ruleMatch: AmbientRuleMatch,
): AmbientDeclarationPolicy[] {
  return ruleMatch.matches.map((filePath) => ({
    allowSharedAcrossOwners: resolvePolicyFlag(
      ruleMatch.rule.allowSharedAcrossOwners,
    ),
    allowTripleSlashReferences: resolvePolicyFlag(
      ruleMatch.rule.allowTripleSlashReferences,
    ),
    filePath,
    reason: ruleMatch.rule.reason,
    ruleIndex: ruleMatch.ruleIndex,
  }));
}

function isEligibleRule(
  ruleMatch: AmbientRuleMatch,
  overlappingRules: ReadonlySet<number>,
): boolean {
  return [
    ruleMatch.matches.length > 0,
    !overlappingRules.has(ruleMatch.ruleIndex),
  ].every(Boolean);
}

async function processRulePolicy(options: {
  context: DeclarationValidationContext;
  overlappingRules: ReadonlySet<number>;
  ruleMatch: AmbientRuleMatch;
}): Promise<RulePolicyResult> {
  if (!isEligibleRule(options.ruleMatch, options.overlappingRules)) {
    return { issues: [], policies: [] };
  }

  const issues = await collectRuleIssues(options.ruleMatch, options.context);

  return issues.length > 0
    ? { issues, policies: [] }
    : { issues, policies: createRulePolicies(options.ruleMatch) };
}

async function createValidationContext(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  workspaceContext: ValidatedWorkspaceContext;
}): Promise<DeclarationValidationContext> {
  return {
    config: options.config,
    liminaDir: normalizeAbsolutePath(
      path.join(options.config.rootDir, '.limina'),
    ),
    managedPaths: collectManagedDeclarationPaths(options.generatedGraph),
    outputDirs: options.workspaceContext.outputRoots,
    publicEntries: await collectWorkspacePackageDeclarationEntryPaths(
      options.workspaceContext.packages,
    ),
  };
}

export async function collectAmbientPolicies(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  overlappingRules: ReadonlySet<number>;
  ruleMatches: readonly AmbientRuleMatch[];
  workspaceContext: ValidatedWorkspaceContext;
}): Promise<RulePolicyResult> {
  const context = await createValidationContext(options);
  const results = await Promise.all(
    options.ruleMatches.map((ruleMatch) =>
      processRulePolicy({
        context,
        overlappingRules: options.overlappingRules,
        ruleMatch,
      }),
    ),
  );

  return {
    issues: results.flatMap((result) => result.issues),
    policies: results.flatMap((result) => result.policies),
  };
}
