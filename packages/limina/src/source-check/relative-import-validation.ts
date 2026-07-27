import type { ResolvedLiminaConfig } from '#config/runner';
import type { ImportRecord } from '#core/import-graph/context';
import type { PackageOwner } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { AmbientDeclarationIndex } from './ambient-declarations';
import { createSourceDiagnosticFinding } from './finding-utils';
import type { SourceFinding } from './findings';
import { addRelativeImportOwnerProblem } from './import-boundary-findings';

function addUnauthorizedTripleSlashFinding(options: {
  config: ResolvedLiminaConfig;
  filePath: string;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  policy: NonNullable<ReturnType<AmbientDeclarationIndex['get']>>;
  resolvedFilePath: string;
}): void {
  const title =
    'Ambient declaration triple-slash path reference is not authorized';
  const reason =
    'allowTripleSlashReferences is false for the matched ambient declaration rule.';
  const fix =
    'set allowTripleSlashReferences: true or remove the triple-slash path reference.';
  const ruleIdentity = `source.declarations.ambient[${options.policy.ruleIndex}]`;
  const lines = [
    `${title}:`,
    `  source owner: ${toRelativePath(options.config.rootDir, options.owner.packageJsonPath)}`,
    `  file: ${toRelativePath(options.config.rootDir, options.filePath)}:${options.importRecord.line}`,
    `  declaration target: ${toRelativePath(options.config.rootDir, options.resolvedFilePath)}`,
    `  rule: ${ruleIdentity}`,
    `  reason: ${reason}`,
    `  fix: ${fix}`,
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      code: LIMINA_CHECK_ISSUE_CODES.sourceAmbientDeclarationReferenceUnauthorized,
      facts: {
        declarationPath: options.resolvedFilePath,
        importerPath: options.filePath,
        kind: 'triple-slash-path-reference',
        line: options.importRecord.line,
        packageManifestPath: options.owner.packageJsonPath,
        packageName: options.owner.name ?? undefined,
        referenceKind: options.importRecord.kind,
        ruleIdentity,
        ruleIndex: options.policy.ruleIndex,
      },
      filePath: options.filePath,
      fix,
      lines,
      ownerName: options.owner.name ?? undefined,
      packageJsonPath: options.owner.packageJsonPath,
      reason,
      scope: ruleIdentity,
      title,
    }),
  );
}

function getAmbientTripleSlashPolicy(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  importRecord: ImportRecord;
  resolvedFilePath: string;
}): NonNullable<ReturnType<AmbientDeclarationIndex['get']>> | null {
  if (options.importRecord.kind !== 'triple-slash-path') {
    return null;
  }

  return options.ambientDeclarations.get(options.resolvedFilePath) ?? null;
}

function handleAmbientTripleSlash(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  config: ResolvedLiminaConfig;
  filePath: string;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  resolvedFilePath: string;
}): boolean {
  const policy = getAmbientTripleSlashPolicy(options);
  if (!policy) {
    return false;
  }

  if (!policy.allowTripleSlashReferences) {
    addUnauthorizedTripleSlashFinding({ ...options, policy });
  }
  return true;
}

function hasSamePackageScope(options: {
  filePath: string;
  resolvedFilePath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): boolean {
  const sourceScope = options.workspaceLookup.findNearestPackageScopeInfo(
    options.filePath,
  );
  const targetScope = options.workspaceLookup.findNearestPackageScopeInfo(
    options.resolvedFilePath,
  );

  return sourceScope?.packageJsonPath === targetScope?.packageJsonPath;
}

function shouldSkipRelativeImport(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  config: ResolvedLiminaConfig;
  filePath: string;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  resolvedFilePath: string;
  workspaceLookup: WorkspaceLookupIndex;
}): boolean {
  if (handleAmbientTripleSlash(options)) {
    return true;
  }

  return hasSamePackageScope(options);
}

export function addRelativeImportProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  config: ResolvedLiminaConfig;
  filePath: string;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  resolvedFilePath: string | null;
  workspaceLookup: WorkspaceLookupIndex;
}): void {
  if (!options.resolvedFilePath) {
    return;
  }

  const context = { ...options, resolvedFilePath: options.resolvedFilePath };
  if (shouldSkipRelativeImport(context)) {
    return;
  }

  addRelativeImportOwnerProblem({
    config: context.config,
    findings: context.findings,
    importRecord: context.importRecord,
    owner: context.owner,
    resolvedFilePath: context.resolvedFilePath,
    sourcePackageScope: context.workspaceLookup.findNearestPackageScopeInfo(
      context.filePath,
    ),
    targetPackageScope: context.workspaceLookup.findNearestPackageScopeInfo(
      context.resolvedFilePath,
    ),
  });
}
