import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import path from 'pathe';
import { LIMINA_CHECK_ISSUE_CODES } from '../check-reporting/codes';
import { normalizeCustomConditions } from './condition-subtree';
import type { ParsedConditionDomain } from './condition-types';
import type { GraphConfigInvalidFinding, GraphFinding } from './findings';

interface DomainConfigIssue {
  field: string;
  reason: string;
  value?: unknown;
}

interface DomainValidatorContext {
  domain: Record<string, unknown>;
  field: string;
}

type DomainValidator = (
  context: DomainValidatorContext,
) => DomainConfigIssue | null;

export function createGeneratedGraphPathAliases(
  generatedGraph: GeneratedTsconfigGraphResult,
): Map<string, string> {
  return new Map(
    [...generatedGraph.sourceToDts.values()].flatMap((sourceToDts) => [
      ...sourceToDts.entries(),
    ]),
  );
}

export function getConditionDomainEntryPath(options: {
  config: ResolvedLiminaConfig;
  entry: string;
}): string {
  return normalizeAbsolutePath(
    path.resolve(options.config.rootDir, options.entry),
  );
}

export function addConditionDomainShapeProblem(options: {
  config: ResolvedLiminaConfig;
  field: string;
  findings: GraphFinding[];
  reason: string;
  value?: unknown;
}): void {
  const hasValue = Object.hasOwn(options, 'value');
  const lines = [
    'Invalid graph condition domain config:',
    `  field: ${options.field}`,
    ...(hasValue ? [`  value: ${formatUnknownValue(options.value)}`] : []),
    `  reason: ${options.reason}`,
  ];

  options.findings.push({
    code: LIMINA_CHECK_ISSUE_CODES.graphConfigInvalid,
    evidence: [
      { label: 'field', value: options.field },
      ...(hasValue
        ? [{ label: 'value', value: formatUnknownValue(options.value) }]
        : []),
    ],
    facts: {
      configPath: options.config.configPath,
      field: options.field,
      kind: 'condition-domain',
    },
    filePath: options.config.configPath,
    locations: [
      { filePath: options.config.configPath, label: 'Limina config' },
    ],
    presentation: {
      detailLines: lines,
      reason: options.reason,
      title: 'Invalid graph condition domain config',
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const validateName: DomainValidator = ({ domain, field }) =>
  isNonEmptyString(domain.name)
    ? null
    : {
        field: `${field}.name`,
        reason: 'condition domain name must be a non-empty string.',
        value: domain.name,
      };

const validateEntry: DomainValidator = ({ domain, field }) => {
  if (!isNonEmptyString(domain.entry)) {
    return {
      field: `${field}.entry`,
      reason:
        'condition domain entry must be a non-empty config-root-relative source tsconfig path.',
      value: domain.entry,
    };
  }

  return path.isAbsolute(domain.entry)
    ? {
        field: `${field}.entry`,
        reason: 'condition domain entry must be relative to config.rootDir.',
        value: domain.entry,
      }
    : null;
};

const validateCustomConditions: DomainValidator = ({ domain, field }) => {
  if (!Array.isArray(domain.customConditions)) {
    return {
      field: `${field}.customConditions`,
      reason: 'condition domain customConditions must be an array of strings.',
      value: domain.customConditions,
    };
  }

  const invalidIndex = domain.customConditions.findIndex(
    (condition) => typeof condition !== 'string',
  );
  return invalidIndex === -1
    ? null
    : {
        field: `${field}.customConditions[${invalidIndex}]`,
        reason: 'condition domain customConditions entries must be strings.',
        value: domain.customConditions[invalidIndex],
      };
};

const domainValidators: readonly DomainValidator[] = [
  validateName,
  validateEntry,
  validateCustomConditions,
];

function findDomainConfigIssue(
  context: DomainValidatorContext,
): DomainConfigIssue | null {
  for (const validate of domainValidators) {
    const issue = validate(context);

    if (issue !== null) {
      return issue;
    }
  }

  return null;
}

function addParsedDomainIssue(options: {
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  issue: DomainConfigIssue;
}): void {
  addConditionDomainShapeProblem({
    config: options.config,
    field: options.issue.field,
    findings: options.findings,
    reason: options.issue.reason,
    ...(Object.hasOwn(options.issue, 'value')
      ? { value: options.issue.value }
      : {}),
  });
}

export function parseConditionDomainEntry(options: {
  config: ResolvedLiminaConfig;
  domain: unknown;
  findings: GraphFinding[];
  index: number;
}): ParsedConditionDomain | null {
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

  const issue = findDomainConfigIssue({ domain: options.domain, field });

  if (issue !== null) {
    addParsedDomainIssue({
      config: options.config,
      findings: options.findings,
      issue,
    });
    return null;
  }

  return {
    customConditions: normalizeCustomConditions(
      options.domain.customConditions as string[],
    ),
    entry: (options.domain.entry as string).trim(),
    name: (options.domain.name as string).trim(),
  };
}

export function addConditionDomainEntryProblem(options: {
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
      { label: 'condition domain', value: options.domainName },
      { label: 'resolved entry', value: options.entryPath },
    ],
    facts: {
      configPath: options.config.configPath,
      field: 'graph.conditionDomains',
      kind: 'condition-domain',
    },
    filePath: options.entryPath,
    locations: [
      { filePath: options.config.configPath, label: 'Limina config' },
      { filePath: options.entryPath, label: 'condition domain entry' },
    ],
    presentation: {
      detailLines: lines,
      reason: options.reason,
      title: options.title,
    },
    task: 'graph:check',
  } satisfies GraphConfigInvalidFinding);
}

function getConfiguredConditionDomains(config: ResolvedLiminaConfig): unknown {
  return config.graph === undefined ? undefined : config.graph.conditionDomains;
}

export function resolveConditionDomains(
  config: ResolvedLiminaConfig,
  findings: GraphFinding[],
): unknown[] | null {
  const domains = getConfiguredConditionDomains(config);

  if (domains === undefined) {
    return null;
  }

  if (Array.isArray(domains)) {
    return domains;
  }

  addConditionDomainShapeProblem({
    config,
    field: 'graph.conditionDomains',
    findings,
    reason: 'conditionDomains must be an array of condition domain objects.',
    value: domains,
  });
  return null;
}
