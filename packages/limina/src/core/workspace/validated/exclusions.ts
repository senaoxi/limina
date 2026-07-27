import type { RegionExcludeConfig, ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath, normalizeSlashes } from '#utils/path';
import rawPicomatch from 'picomatch';
import type { WorkspacePackage } from '../actions';
import { displayWorkspacePath } from './shared';
import type { WorkspaceDescriptorCandidate } from './types';

export interface CompiledExclusionRule {
  entry: RegionExcludeConfig;
  index: number;
  matchers: ((value: string) => boolean)[];
}

interface ExclusionCandidate {
  kind: 'package-scope' | 'workspace-package';
  rootDir: string;
}

const picomatch = rawPicomatch as unknown as (
  pattern: string,
  options?: { dot?: boolean; posixSlashes?: boolean },
) => (value: string) => boolean;

function normalizeExcludePattern(pattern: string): string {
  return normalizeSlashes(pattern.trim()).replaceAll(/^\.\//gu, '');
}

export function compileExclusionRules(
  config: ResolvedLiminaConfig,
): CompiledExclusionRule[] {
  return (config.regions?.exclude ?? []).map((entry, index) => ({
    entry,
    index,
    matchers: entry.include.map((pattern) =>
      picomatch(normalizeExcludePattern(pattern), {
        dot: true,
        posixSlashes: true,
      }),
    ),
  }));
}

export function findExactExclusions(options: {
  config: ResolvedLiminaConfig;
  kind: ExclusionCandidate['kind'];
  rootDir: string;
  rules: readonly CompiledExclusionRule[];
}): CompiledExclusionRule[] {
  const relativeRoot = displayWorkspacePath(
    options.config.rootDir,
    options.rootDir,
  );
  return options.rules.filter((rule) => {
    if (rule.entry.kind !== options.kind) return false;
    return rule.matchers.some((matchesPattern) => matchesPattern(relativeRoot));
  });
}

export function applyWorkspacePackageExclusions(options: {
  config: ResolvedLiminaConfig;
  rawPackages: readonly WorkspacePackage[];
  rules: readonly CompiledExclusionRule[];
}): WorkspacePackage[] {
  return options.rawPackages.filter((workspacePackage) => {
    const matches = findExactExclusions({
      config: options.config,
      kind: 'workspace-package',
      rootDir: workspacePackage.directory,
      rules: options.rules,
    });
    return matches.length === 0;
  });
}

function candidateMatchesRule(options: {
  candidate: ExclusionCandidate;
  config: ResolvedLiminaConfig;
  rule: CompiledExclusionRule;
}): boolean {
  if (options.candidate.kind !== options.rule.entry.kind) return false;
  const candidatePath = displayWorkspacePath(
    options.config.rootDir,
    options.candidate.rootDir,
  );
  return options.rule.matchers.some((matches) => matches(candidatePath));
}

function validateCandidateMatch(options: {
  candidate: ExclusionCandidate;
  config: ResolvedLiminaConfig;
  rules: readonly CompiledExclusionRule[];
}): void {
  const matches = findExactExclusions({
    config: options.config,
    kind: options.candidate.kind,
    rootDir: options.candidate.rootDir,
    rules: options.rules,
  });
  if (matches.length < 2) return;
  throw new Error(
    `Multiple regions.exclude rules match ${options.candidate.kind} ${displayWorkspacePath(options.config.rootDir, options.candidate.rootDir)}.`,
  );
}

function findUnmatchedRule(options: {
  candidates: readonly ExclusionCandidate[];
  config: ResolvedLiminaConfig;
  rules: readonly CompiledExclusionRule[];
}): CompiledExclusionRule | undefined {
  return options.rules.find(
    (rule) =>
      !options.candidates.some((candidate) =>
        candidateMatchesRule({ candidate, config: options.config, rule }),
      ),
  );
}

function validateExclusionRules(options: {
  candidates: readonly ExclusionCandidate[];
  config: ResolvedLiminaConfig;
  rules: readonly CompiledExclusionRule[];
}): void {
  for (const candidate of options.candidates) {
    validateCandidateMatch({ ...options, candidate });
  }
  const unmatched = findUnmatchedRule(options);
  if (unmatched === undefined) return;
  throw new Error(
    `regions.exclude[${unmatched.index}] does not match an exact governance candidate.`,
  );
}

export function validateWorkspacePackageExclusions(options: {
  config: ResolvedLiminaConfig;
  rawPackages: readonly WorkspacePackage[];
  rules: readonly CompiledExclusionRule[];
}): void {
  validateExclusionRules({
    candidates: options.rawPackages.map((workspacePackage) => ({
      kind: 'workspace-package',
      rootDir: workspacePackage.directory,
    })),
    config: options.config,
    rules: options.rules.filter(
      (rule) => rule.entry.kind === 'workspace-package',
    ),
  });
}

export function validatePackageScopeExclusions(options: {
  config: ResolvedLiminaConfig;
  rules: readonly CompiledExclusionRule[];
  stableCandidates: readonly WorkspaceDescriptorCandidate[];
}): void {
  const candidates = options.stableCandidates
    .filter((candidate) => candidate.kind === 'package-json')
    .filter(
      (candidate) =>
        normalizeAbsolutePath(candidate.rootDir) !==
        normalizeAbsolutePath(candidate.ownerDirectory),
    )
    .map((candidate) => ({
      kind: 'package-scope' as const,
      rootDir: candidate.rootDir,
    }));
  validateExclusionRules({
    candidates,
    config: options.config,
    rules: options.rules.filter((rule) => rule.entry.kind === 'package-scope'),
  });
}
