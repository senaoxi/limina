import { identifier } from '../shared/identifiers';
import type { RuleDescriptor } from './contracts';

export function createNoOptionsDescriptor<
  const Kind extends string,
  MessageId extends string,
>(options: {
  readonly category: RuleDescriptor<Kind, undefined, MessageId>['category'];
  readonly description: string;
  readonly documentation: string;
  readonly id: string;
  readonly inputKind: Kind;
  readonly messages: RuleDescriptor<Kind, undefined, MessageId>['messages'];
}): RuleDescriptor<Kind, undefined, MessageId> {
  return Object.freeze({
    category: options.category,
    defaultSeverity: 'error',
    description: options.description,
    documentation: { url: options.documentation },
    id: identifier<'RuleId'>(options.id),
    inputKind: options.inputKind,
    messages: options.messages,
    options: { kind: 'none' } as const,
  });
}
