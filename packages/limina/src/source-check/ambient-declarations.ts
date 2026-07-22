import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  isPathInsideDirectory,
  normalizeAbsolutePath,
  toPosixPath,
  toRelativePath,
} from '#utils/path';
import { readFile } from 'node:fs/promises';
import path from 'pathe';
import ts from 'typescript';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { collectWorkspacePackageDeclarationEntryPaths } from '../core/workspace/exports';
import {
  collectActivatedPackageFileCandidates,
  createCandidateGlobMatcher,
  type WorkspaceRegionFilePathIndex,
} from '../core/workspace/file-candidates';
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
import type {
  SourceAmbientDeclarationConfigInvalidFacts,
  SourceFinding,
  SourceFindingForCode,
} from './findings';

export interface AmbientDeclarationPolicy {
  allowSharedAcrossOwners: boolean;
  allowTripleSlashReferences: boolean;
  filePath: string;
  reason: string;
  ruleIndex: number;
}

export interface AmbientDeclarationIndex {
  get(filePath: string): AmbientDeclarationPolicy | null;
  has(filePath: string): boolean;
}

export interface AmbientDeclarationIndexResult {
  index: AmbientDeclarationIndex;
  issues: SourceFinding[];
}

class AmbientDeclarationIndexImpl implements AmbientDeclarationIndex {
  readonly #policies: Map<string, AmbientDeclarationPolicy>;
  constructor(policies: Iterable<readonly [string, AmbientDeclarationPolicy]>) {
    this.#policies = new Map(policies);
  }
  get(filePath: string): AmbientDeclarationPolicy | null {
    return this.#policies.get(normalizeAbsolutePath(filePath)) ?? null;
  }
  has(filePath: string): boolean {
    return this.#policies.has(normalizeAbsolutePath(filePath));
  }
}

function createConfigIssue(options: {
  config: ResolvedLiminaConfig;
  details?: string[];
  facts: SourceAmbientDeclarationConfigInvalidFacts;
  filePath?: string;
  reason: string;
}): SourceFindingForCode<
  typeof LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid
> {
  const rule = options.facts.ruleIdentity;
  const lines = [
    `rule: ${rule}`,
    ...(options.filePath
      ? [`file: ${toRelativePath(options.config.rootDir, options.filePath)}`]
      : []),
    ...(options.details ?? []),
    `reason: ${options.reason}`,
  ];
  return {
    code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationConfigInvalid,
    detailLines: lines,
    detector: 'source',
    evidence: [{ label: 'diagnostic', lines }],
    facts: options.facts,
    ...(options.filePath ? { filePath: options.filePath } : {}),
    ownerName: '<workspace>',
    reason: options.reason,
    scope: rule,
    summary: 'Ambient declaration configuration is invalid',
    task: 'source:check',
    title: 'Ambient declaration configuration is invalid',
  };
}

function isDeclarationFile(filePath: string): boolean {
  return /\.d\.(?:cts|mts|ts)$/u.test(filePath);
}

function isEmptyExportMarker(statement: ts.Statement): boolean {
  return (
    ts.isExportDeclaration(statement) &&
    !statement.moduleSpecifier &&
    Boolean(
      statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length === 0,
    )
  );
}

function isDeclareGlobalStatement(statement: ts.Statement): boolean {
  return (
    ts.isModuleDeclaration(statement) &&
    (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0
  );
}

async function hasAmbientDeclarationRole(filePath: string): Promise<boolean> {
  const sourceFile = ts.createSourceFile(
    filePath,
    await readFile(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (!ts.isExternalModule(sourceFile)) return true;
  return sourceFile.statements.every(
    (statement) =>
      ts.isEmptyStatement(statement) ||
      isEmptyExportMarker(statement) ||
      isDeclareGlobalStatement(statement),
  );
}

function collectManagedDeclarationPaths(
  graph: GeneratedTsconfigGraphResult,
): Set<string> {
  return new Set(
    [...graph.dtsToSource.values()].flatMap((mapping) =>
      [...mapping.keys()].map(normalizeAbsolutePath),
    ),
  );
}

export async function createAmbientDeclarationIndex(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  workspaceContext: ValidatedWorkspaceContext;
  workspacePathIndex?: WorkspaceRegionFilePathIndex;
}): Promise<AmbientDeclarationIndexResult> {
  const rules = options.config.source?.declarations?.ambient ?? [];
  const issues: SourceFinding[] = [];
  const candidates = await collectActivatedPackageFileCandidates(
    options.workspaceContext,
    options.workspacePathIndex,
  );
  const matchesByRule = rules.map((rule) => {
    const matches = createCandidateGlobMatcher(rule.include);
    return candidates.filter((filePath) =>
      matches(toPosixPath(toRelativePath(options.config.rootDir, filePath))),
    );
  });
  const ruleIndexesByFile = new Map<string, number[]>();

  for (const [ruleIndex, matches] of matchesByRule.entries()) {
    if (matches.length === 0) {
      issues.push(
        createConfigIssue({
          config: options.config,
          details: [`include: ${rules[ruleIndex]!.include.join(', ')}`],
          facts: {
            include: rules[ruleIndex]!.include,
            kind: 'no-matches',
            ruleIdentity: `source.declarations.ambient[${ruleIndex}]`,
            ruleIndex,
          },
          reason:
            'ambient declaration rules must match at least one existing declaration file.',
        }),
      );
    }
    for (const filePath of matches) {
      const indexes = ruleIndexesByFile.get(filePath) ?? [];
      indexes.push(ruleIndex);
      ruleIndexesByFile.set(filePath, indexes);
    }
  }

  const overlappingRules = new Set<number>();
  for (const [filePath, indexes] of ruleIndexesByFile) {
    if (indexes.length <= 1) continue;
    for (const ruleIndex of indexes) {
      overlappingRules.add(ruleIndex);
      issues.push(
        createConfigIssue({
          config: options.config,
          details: [
            `matching rules: ${indexes.map((index) => `source.declarations.ambient[${index}]`).join(', ')}`,
          ],
          facts: {
            declarationPath: filePath,
            kind: 'overlapping-rules',
            matchingRuleIdentities: indexes.map(
              (index) => `source.declarations.ambient[${index}]`,
            ),
            ruleIdentity: `source.declarations.ambient[${ruleIndex}]`,
            ruleIndex,
          },
          filePath,
          reason:
            'one physical declaration file cannot match multiple ambient declaration rules.',
        }),
      );
    }
  }

  const managedPaths = collectManagedDeclarationPaths(options.generatedGraph);
  const outputDirs = options.workspaceContext.outputRoots;
  const publicEntries = await collectWorkspacePackageDeclarationEntryPaths(
    options.workspaceContext.packages,
  );
  const liminaDir = normalizeAbsolutePath(
    path.join(options.config.rootDir, '.limina'),
  );
  const policies = new Map<string, AmbientDeclarationPolicy>();

  for (const [ruleIndex, matches] of matchesByRule.entries()) {
    const rule = rules[ruleIndex]!;
    let valid = matches.length > 0 && !overlappingRules.has(ruleIndex);
    for (const filePath of matches) {
      let reason: string | null = null;
      let violation:
        | 'managed-output'
        | 'not-ambient-role'
        | 'not-declaration-file'
        | 'public-declaration-entry'
        | null = null;
      if (!isDeclarationFile(filePath)) {
        reason =
          'ambient declaration rules may only match .d.ts, .d.cts, or .d.mts files.';
        violation = 'not-declaration-file';
      } else if (
        isPathInsideDirectory(filePath, liminaDir) ||
        outputDirs.some((dir) => isPathInsideDirectory(filePath, dir)) ||
        managedPaths.has(filePath)
      ) {
        reason =
          'managed output declarations cannot be classified as ambient declarations.';
        violation = 'managed-output';
      } else if (publicEntries.has(filePath)) {
        reason =
          'workspace package public declaration entries cannot be classified as ambient declarations.';
        violation = 'public-declaration-entry';
      } else if (!(await hasAmbientDeclarationRole(filePath))) {
        reason =
          'ordinary external declaration modules with imports, exports, or re-exports remain package-owned declaration APIs.';
        violation = 'not-ambient-role';
      }
      if (!reason || !violation) continue;
      valid = false;
      issues.push(
        createConfigIssue({
          config: options.config,
          facts: {
            declarationPath: filePath,
            kind: 'invalid-declaration',
            ruleIdentity: `source.declarations.ambient[${ruleIndex}]`,
            ruleIndex,
            violation,
          },
          filePath,
          reason,
        }),
      );
    }
    if (!valid) continue;
    for (const filePath of matches) {
      policies.set(filePath, {
        allowSharedAcrossOwners: rule.allowSharedAcrossOwners ?? false,
        allowTripleSlashReferences: rule.allowTripleSlashReferences ?? false,
        filePath,
        reason: rule.reason,
        ruleIndex,
      });
    }
  }

  return { index: new AmbientDeclarationIndexImpl(policies), issues };
}
