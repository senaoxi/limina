import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatImportRecordLocation,
  type ImportRecord,
} from '#core/import-graph/context';
import type { PackageOwner } from '#core/workspace/actions';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { ResourceImportFact } from '../core/facts/resource';
import { createSourceDiagnosticFinding } from './finding-utilities';
import type { SourceFinding } from './findings';

interface ResourceModuleOptions {
  config: ResolvedLiminaConfig;
  configPath: string;
  findings: SourceFinding[];
  importRecord: ImportRecord;
  owner: PackageOwner;
  resource: ResourceImportFact;
}

export function addResourceModuleProblems(
  options: ResourceModuleOptions,
): void {
  const { checkerName, physical } = options.resource;
  if (physical.kind !== 'missing') return;
  const { checkedPath } = physical;
  const title = 'Resource module was not found';
  const lines = [
    `${title}:`,
    `  import: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  specifier: ${options.importRecord.specifier}`,
    `  checker: ${checkerName}`,
    ...(checkedPath
      ? [
          `  checked path: ${toRelativePath(options.config.rootDir, checkedPath)}`,
        ]
      : []),
    '  type evidence: unobserved',
  ];

  options.findings.push(
    createSourceDiagnosticFinding({
      checkerName,
      code: LIMINA_CHECK_ISSUE_CODES.sourceResourceModuleNotFound,
      facts: {
        checkedPath,
        checkerName,
        configPath: options.configPath,
        importerPath: options.importRecord.filePath,
        kind: 'resource-module-not-found',
        line: options.importRecord.line,
        specifier: options.importRecord.specifier,
        typeEvidenceKind: 'unobserved',
      },
      filePath: options.importRecord.filePath,
      fix: 'Create the referenced resource at the resolved path or correct the import specifier.',
      lines,
      locations: [
        {
          filePath: options.importRecord.filePath,
          label: 'import',
          line: options.importRecord.line,
        },
      ],
      ownerName: options.owner.name,
      packageJsonPath: options.owner.packageJsonPath,
      reason:
        'Ambient or concrete type evidence cannot establish that a physical resource exists at runtime.',
      title,
    }),
  );
}
