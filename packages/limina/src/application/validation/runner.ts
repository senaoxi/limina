import { createValidationReportCollector } from '../../domain/validation/context';
import type {
  IssueReportInput,
  RuleDescriptor,
  TypedValidatorRegistration,
} from '../../domain/validation/contracts';
import {
  CancelledFailure,
  ExecutionFailure,
  throwIfCancelled,
} from '../../domain/validation/errors';
import {
  assembleGovernanceIssue,
  type GovernanceIssue,
  type GovernanceIssueOrigin,
  sortGovernanceIssues,
} from '../../domain/validation/issues';
import { parseRuleOptions } from '../../domain/validation/options';
import type { AnalysisRun } from '../analysis/analysis-run';

export interface RunTypedValidatorOptions<
  Kind extends string,
  View,
  Options,
  MessageId extends string,
> {
  readonly configuredOptions: unknown;
  readonly origin: GovernanceIssueOrigin;
  readonly registration: TypedValidatorRegistration<
    Kind,
    View,
    Options,
    MessageId
  >;
  readonly run: AnalysisRun;
  readonly view: View;
}

export interface PreparedTypedValidator<View> {
  execute(view: View, run: AnalysisRun): Promise<readonly GovernanceIssue[]>;
}

function assembleReports<
  Kind extends string,
  Options,
  MessageId extends string,
>(
  descriptor: RuleDescriptor<Kind, Options, MessageId>,
  origin: GovernanceIssueOrigin,
  reports: readonly IssueReportInput<MessageId>[],
): readonly GovernanceIssue[] {
  return reports.map((report) =>
    assembleGovernanceIssue({ descriptor, origin, report }),
  );
}

export async function runTypedValidator<
  Kind extends string,
  View,
  Options,
  MessageId extends string,
>(
  options: RunTypedValidatorOptions<Kind, View, Options, MessageId>,
): Promise<readonly GovernanceIssue[]> {
  const parsedOptions = parseRuleOptions(
    options.registration.descriptor,
    options.configuredOptions,
  );
  return executeParsedValidator({ ...options, parsedOptions });
}

async function executeParsedValidator<
  Kind extends string,
  View,
  Options,
  MessageId extends string,
>(
  options: RunTypedValidatorOptions<Kind, View, Options, MessageId> & {
    readonly parsedOptions: Options;
  },
): Promise<readonly GovernanceIssue[]> {
  throwIfCancelled(options.run.signal);

  const collector = createValidationReportCollector<MessageId>(
    options.run.signal,
  );
  const startedAt = performance.now();

  try {
    await options.registration.validate(
      options.view,
      collector.context,
      options.parsedOptions,
    );
  } catch (error) {
    if (options.run.signal.aborted || error instanceof CancelledFailure) {
      throw new CancelledFailure();
    }

    throw new ExecutionFailure(
      `Validator "${options.registration.descriptor.id}" failed.`,
      {
        cause: error,
        stage: options.registration.descriptor.inputKind,
      },
    );
  } finally {
    options.run.metrics.record({
      durationMs: performance.now() - startedAt,
      kind: options.registration.descriptor.inputKind,
      name: 'validator',
      reports: collector.reports.length,
    });
  }

  throwIfCancelled(options.run.signal);

  return sortGovernanceIssues(
    assembleReports(
      options.registration.descriptor,
      options.origin,
      collector.reports,
    ),
  );
}

export function prepareTypedValidator<
  Kind extends string,
  View,
  Options,
  MessageId extends string,
>(options: {
  readonly configuredOptions: unknown;
  readonly origin: GovernanceIssueOrigin;
  readonly registration: TypedValidatorRegistration<
    Kind,
    View,
    Options,
    MessageId
  >;
}): PreparedTypedValidator<View> {
  const parsedOptions = parseRuleOptions(
    options.registration.descriptor,
    options.configuredOptions,
  );

  return Object.freeze({
    async execute(
      view: View,
      run: AnalysisRun,
    ): Promise<readonly GovernanceIssue[]> {
      return executeParsedValidator({
        configuredOptions: undefined,
        origin: options.origin,
        parsedOptions,
        registration: options.registration,
        run,
        view,
      });
    },
  });
}
