import type { ResolvedLiminaConfig } from '#config/runner';
import {
  formatImportRecordLocation,
  formatProjectLabels,
  type ImportRecord,
  type ProjectInfo,
} from '#core/import-graph/context';
import { toRelativePath } from '#utils/path';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import type { LiminaCheckIssueEvidence } from '../check-reporting/snapshot';
import { createGraphImportFact, getProjectCheckerName } from './finding-utils';
import type { GraphAccessDeniedFinding, GraphFinding } from './findings';
import type { GraphRuleDepDeny, GraphRuleRefDeny } from './rules';

interface DeniedImportOptions {
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  importRecord: ImportRecord;
  project: ProjectInfo;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
}

function createImportEvidence(
  importRecord: ImportRecord,
): LiminaCheckIssueEvidence {
  return {
    label: 'import',
    lines: [
      `file: ${importRecord.filePath}`,
      `line: ${importRecord.line}`,
      `kind: ${importRecord.kind}`,
    ],
    value: importRecord.specifier,
  };
}

export function addDeniedDepImportProblem(
  options: DeniedImportOptions & { rule: GraphRuleDepDeny },
): void {
  const detailLines = [
    'Denied graph access:',
    `  rules: ${formatProjectLabels(options.project.labels)}`,
    `  importing project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  denied dependency: ${options.rule.name}`,
    `  reason: ${options.rule.reason}`,
  ];

  options.findings.push({
    checkerName: getProjectCheckerName(
      options.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
    evidence: [
      createImportEvidence(options.importRecord),
      { label: 'denied dependency', value: options.rule.name },
    ],
    facts: {
      deniedDependency: options.rule.name,
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'import-dependency',
      labels: [...options.project.labels],
      ruleReason: options.rule.reason,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      { filePath: options.project.configPath, label: 'importing project' },
    ],
    packageName: options.rule.name,
    presentation: {
      detailLines,
      reason: options.rule.reason,
      title: 'Denied graph access',
    },
    task: 'graph:check',
  } satisfies GraphAccessDeniedFinding);
}

export function addDeniedRefImportProblem(
  options: DeniedImportOptions & {
    rule: GraphRuleRefDeny;
    targetProjectPath: string;
  },
): void {
  const detailLines = [
    'Denied graph access:',
    `  rules: ${formatProjectLabels(options.project.labels)}`,
    `  importing project: ${toRelativePath(options.config.rootDir, options.project.configPath)}`,
    `  file: ${formatImportRecordLocation(options.config.rootDir, options.importRecord)}`,
    `  imported specifier: ${options.importRecord.specifier}`,
    `  target project: ${toRelativePath(options.config.rootDir, options.targetProjectPath)}`,
    `  denied ref: ${toRelativePath(options.config.rootDir, options.rule.path)}`,
    `  reason: ${options.rule.reason}`,
  ];

  options.findings.push({
    checkerName: getProjectCheckerName(
      options.projectCheckerNamesByPath,
      options.project.configPath,
    ),
    code: LIMINA_CHECK_ISSUE_CODES.graphAccessDenied,
    evidence: [
      createImportEvidence(options.importRecord),
      { label: 'denied reference', value: options.rule.path },
    ],
    facts: {
      deniedReferencePath: options.rule.path,
      import: createGraphImportFact(options.importRecord),
      importingProjectPath: options.project.configPath,
      kind: 'import-reference',
      labels: [...options.project.labels],
      ruleReason: options.rule.reason,
      targetProjectPath: options.targetProjectPath,
    },
    filePath: options.importRecord.filePath,
    locations: [
      {
        filePath: options.importRecord.filePath,
        label: 'import',
        line: options.importRecord.line,
      },
      { filePath: options.project.configPath, label: 'importing project' },
      { filePath: options.targetProjectPath, label: 'target project' },
    ],
    presentation: {
      detailLines,
      reason: options.rule.reason,
      title: 'Denied graph access',
    },
    task: 'graph:check',
  } satisfies GraphAccessDeniedFinding);
}
