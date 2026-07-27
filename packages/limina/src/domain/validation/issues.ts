import { createHash } from 'node:crypto';
import type { GovernanceIssueId, RuleId } from '../shared/identifiers';
import { identifier } from '../shared/identifiers';
import type {
  IssueReportInput,
  IssueSeverity,
  RuleDescriptor,
  RuleMessageTemplate,
} from './contracts';

export interface GovernanceIssueLocation {
  readonly column?: number;
  readonly fileId?: string;
  readonly line?: number;
  readonly path?: string;
  readonly projectId?: string;
}

export interface GovernanceIssueEvidence {
  readonly kind: string;
  readonly location?: GovernanceIssueLocation;
  readonly value: string;
}

export interface GovernanceIssueOrigin {
  readonly kind: 'built-in';
  readonly suite: 'architecture' | 'package-output' | 'release';
}

export interface GovernanceIssue {
  readonly category: string;
  readonly documentation: string;
  readonly evidence: readonly GovernanceIssueEvidence[];
  readonly id: GovernanceIssueId;
  readonly location?: GovernanceIssueLocation;
  readonly message: string;
  readonly messageId: string;
  readonly origin: GovernanceIssueOrigin;
  readonly ruleId: RuleId;
  readonly severity: IssueSeverity;
  readonly title: string;
}

export interface AssembleGovernanceIssueOptions<
  Kind extends string,
  Options,
  MessageId extends string,
> {
  readonly descriptor: RuleDescriptor<Kind, Options, MessageId>;
  readonly origin: GovernanceIssueOrigin;
  readonly report: IssueReportInput<MessageId>;
  readonly severity?: IssueSeverity;
}

function interpolate(
  template: string,
  values: Readonly<Record<string, boolean | number | string>> | undefined,
): string {
  return template.replaceAll(/\{([\w.-]+)\}/gu, (placeholder, key: string) =>
    values && Object.hasOwn(values, key) ? String(values[key]) : placeholder,
  );
}

function stableIssueId(input: Omit<GovernanceIssue, 'id'>): GovernanceIssueId {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        evidence: input.evidence,
        location: input.location,
        messageId: input.messageId,
        origin: input.origin,
        ruleId: input.ruleId,
      }),
    )
    .digest('hex')
    .slice(0, 20);

  return identifier<'GovernanceIssueId'>(`${input.ruleId}:${digest}`);
}

function getMessageTemplate<
  Kind extends string,
  Options,
  MessageId extends string,
>(
  options: AssembleGovernanceIssueOptions<Kind, Options, MessageId>,
): RuleMessageTemplate {
  const template = options.descriptor.messages[options.report.messageId];

  if (!template) {
    throw new Error(
      `Rule "${options.descriptor.id}" reported unknown message "${options.report.messageId}".`,
    );
  }

  return template;
}

function createIssueWithoutId<
  Kind extends string,
  Options,
  MessageId extends string,
>(
  options: AssembleGovernanceIssueOptions<Kind, Options, MessageId>,
  template: RuleMessageTemplate,
): Omit<GovernanceIssue, 'id'> {
  return {
    category: options.descriptor.category,
    documentation: options.descriptor.documentation.url,
    evidence: Object.freeze([...(options.report.evidence ?? [])]),
    location: options.report.location,
    message: interpolate(template.text, options.report.values),
    messageId: options.report.messageId,
    origin: options.origin,
    ruleId: options.descriptor.id,
    severity: options.severity ?? options.descriptor.defaultSeverity,
    title: interpolate(template.title, options.report.values),
  };
}

export function assembleGovernanceIssue<
  Kind extends string,
  Options,
  MessageId extends string,
>(
  options: AssembleGovernanceIssueOptions<Kind, Options, MessageId>,
): GovernanceIssue {
  const issueWithoutId = createIssueWithoutId(
    options,
    getMessageTemplate(options),
  );

  return Object.freeze({
    ...issueWithoutId,
    id: stableIssueId(issueWithoutId),
  });
}

function getLocationPath(issue: GovernanceIssue): string {
  return issue.location?.path ?? '';
}

function getLocationLine(issue: GovernanceIssue): number {
  return issue.location?.line ?? 0;
}

function firstNonZero(comparisons: readonly number[]): number {
  for (const comparison of comparisons) {
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

export function compareGovernanceIssues(
  left: GovernanceIssue,
  right: GovernanceIssue,
): number {
  return firstNonZero([
    left.ruleId.localeCompare(right.ruleId),
    getLocationPath(left).localeCompare(getLocationPath(right)),
    getLocationLine(left) - getLocationLine(right),
    left.message.localeCompare(right.message),
    left.id.localeCompare(right.id),
  ]);
}

export function sortGovernanceIssues(
  issues: readonly GovernanceIssue[],
): readonly GovernanceIssue[] {
  return Object.freeze([...issues].sort(compareGovernanceIssues));
}
