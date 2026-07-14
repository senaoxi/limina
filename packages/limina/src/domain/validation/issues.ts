import { createHash } from 'node:crypto';
import type { GovernanceIssueId, RuleId } from '../shared/identifiers';
import { identifier } from '../shared/identifiers';
import type {
  IssueReportInput,
  IssueSeverity,
  RuleDescriptor,
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

export function assembleGovernanceIssue<
  Kind extends string,
  Options,
  MessageId extends string,
>(
  options: AssembleGovernanceIssueOptions<Kind, Options, MessageId>,
): GovernanceIssue {
  const messageTemplate = options.descriptor.messages[options.report.messageId];

  if (!messageTemplate) {
    throw new Error(
      `Rule "${options.descriptor.id}" reported unknown message "${options.report.messageId}".`,
    );
  }

  const issueWithoutId: Omit<GovernanceIssue, 'id'> = {
    category: options.descriptor.category,
    documentation: options.descriptor.documentation.url,
    evidence: Object.freeze([...(options.report.evidence ?? [])]),
    location: options.report.location,
    message: interpolate(messageTemplate.text, options.report.values),
    messageId: options.report.messageId,
    origin: options.origin,
    ruleId: options.descriptor.id,
    severity: options.severity ?? options.descriptor.defaultSeverity,
    title: interpolate(messageTemplate.title, options.report.values),
  };

  return Object.freeze({
    ...issueWithoutId,
    id: stableIssueId(issueWithoutId),
  });
}

export function compareGovernanceIssues(
  left: GovernanceIssue,
  right: GovernanceIssue,
): number {
  return (
    left.ruleId.localeCompare(right.ruleId) ||
    (left.location?.path ?? '').localeCompare(right.location?.path ?? '') ||
    (left.location?.line ?? 0) - (right.location?.line ?? 0) ||
    left.message.localeCompare(right.message) ||
    left.id.localeCompare(right.id)
  );
}

export function sortGovernanceIssues(
  issues: readonly GovernanceIssue[],
): readonly GovernanceIssue[] {
  return Object.freeze([...issues].sort(compareGovernanceIssues));
}
