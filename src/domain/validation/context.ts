import type {
  IssueReportInput,
  RuleMessageValues,
  ValidationContext,
} from './contracts';
import type {
  GovernanceIssueEvidence,
  GovernanceIssueLocation,
} from './issues';

export interface ValidationReportCollector<MessageId extends string> {
  readonly context: ValidationContext<MessageId>;
  readonly reports: readonly IssueReportInput<MessageId>[];
}

function copyLocation(
  location: GovernanceIssueLocation | undefined,
): GovernanceIssueLocation | undefined {
  return location ? Object.freeze({ ...location }) : undefined;
}

function copyEvidence(
  evidence: readonly GovernanceIssueEvidence[] | undefined,
): readonly GovernanceIssueEvidence[] | undefined {
  return evidence
    ? Object.freeze(
        evidence.map((item) =>
          Object.freeze({
            ...item,
            location: copyLocation(item.location),
          }),
        ),
      )
    : undefined;
}

function copyValues(
  values: RuleMessageValues | undefined,
): RuleMessageValues | undefined {
  return values ? Object.freeze({ ...values }) : undefined;
}

function copyReport<MessageId extends string>(
  input: IssueReportInput<MessageId>,
): IssueReportInput<MessageId> {
  return Object.freeze({
    evidence: copyEvidence(input.evidence),
    location: copyLocation(input.location),
    messageId: input.messageId,
    values: copyValues(input.values),
  });
}

export function createValidationReportCollector<MessageId extends string>(
  signal: AbortSignal,
): ValidationReportCollector<MessageId> {
  const reports: IssueReportInput<MessageId>[] = [];

  return Object.freeze({
    context: Object.freeze({
      report(input: IssueReportInput<MessageId>): void {
        reports.push(copyReport(input));
      },
      signal,
    }),
    reports,
  });
}
