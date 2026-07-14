import type { RuleDescriptor, RuleOptionProblem } from './contracts';
import { ConfigurationError } from './errors';

function hasConfiguredValue(input: unknown): boolean {
  return input !== undefined;
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
    if (hasConfiguredValue(input)) {
      const problem: RuleOptionProblem = {
        message: `Rule "${descriptor.id}" does not accept options.`,
        path: [],
      };

      throw new ConfigurationError(problem.message, [problem]);
    }

    return undefined as Options;
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
