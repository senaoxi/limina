import type { RuleDescriptor, RuleOptionProblem } from './contracts';
import { ConfigurationError } from './errors';

function rejectUnexpectedOptions(ruleId: string, input: unknown): void {
  if (input === undefined) {
    return;
  }

  const problem: RuleOptionProblem = {
    message: `Rule "${ruleId}" does not accept options.`,
    path: [],
  };

  throw new ConfigurationError(problem.message, [problem]);
}

function parseSchemaOptions<Options>(
  descriptor: RuleDescriptor<string, Options, string>,
  input: unknown,
): Options {
  if (descriptor.options.kind !== 'schema') {
    throw new Error(`Rule "${descriptor.id}" has no options schema.`);
  }

  const result = descriptor.options.schema.parse(input);

  if (!result.success) {
    throw new ConfigurationError(
      `Options for rule "${descriptor.id}" are invalid.`,
      result.problems,
    );
  }

  return result.value;
}

export function parseRuleOptions<
  Kind extends string,
  Options,
  MessageId extends string,
>(
  descriptor: RuleDescriptor<Kind, Options, MessageId>,
  input: unknown,
): Options {
  if (descriptor.options.kind === 'none') {
    rejectUnexpectedOptions(descriptor.id, input);
    return undefined as Options;
  }

  return parseSchemaOptions(descriptor, input);
}
