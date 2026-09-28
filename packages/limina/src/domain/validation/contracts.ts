import type { RuleId } from '../shared/identifiers';
import type {
  GovernanceIssueEvidence,
  GovernanceIssueLocation,
} from './issues';

export type ArchitectureValidationInputKind =
  | 'declaration-build'
  | 'import-facts'
  | 'output-build'
  | 'package-artifacts'
  | 'projects'
  | 'source-dependencies'
  | 'workspace';

export type PackageOutputValidationInputKind = 'package-output';
export type ReleaseValidationInputKind = 'release-assessment';

export type InternalValidationInputKind =
  | ArchitectureValidationInputKind
  | PackageOutputValidationInputKind
  | ReleaseValidationInputKind;

export type IssueSeverity = 'error' | 'info' | 'warning';

export type RuleCategory =
  | 'architecture'
  | 'build'
  | 'dependency'
  | 'ownership'
  | 'package-output'
  | 'release'
  | 'workspace';

export interface DocumentationReference {
  readonly url: string;
}

export interface RuleOptionProblem {
  readonly message: string;
  readonly path: readonly (number | string)[];
}

export interface RuleOptionsSchema<Options> {
  parse(input: unknown):
    | {
        readonly success: false;
        readonly problems: readonly RuleOptionProblem[];
      }
    | { readonly success: true; readonly value: Options };
}

export type RuleOptionsDefinition<Options> =
  | { readonly kind: 'none' }
  | { readonly kind: 'schema'; readonly schema: RuleOptionsSchema<Options> };

export type NoRuleOptions = undefined;

export interface RuleMessageTemplate {
  readonly text: string;
  readonly title: string;
}

export interface RuleDescriptor<
  Kind extends string,
  Options,
  MessageId extends string,
> {
  readonly category: RuleCategory;
  readonly defaultSeverity: IssueSeverity;
  readonly description: string;
  readonly documentation: DocumentationReference;
  readonly id: RuleId;
  readonly inputKind: Kind;
  readonly messages: Readonly<Record<MessageId, RuleMessageTemplate>>;
  readonly options: RuleOptionsDefinition<Options>;
}

export type RuleMessageValues = Readonly<
  Record<string, boolean | number | string>
>;

export interface IssueReportInput<MessageId extends string> {
  readonly evidence?: readonly GovernanceIssueEvidence[];
  readonly location?: GovernanceIssueLocation;
  readonly messageId: MessageId;
  readonly values?: RuleMessageValues;
}

export interface ValidationContext<MessageId extends string> {
  readonly signal: AbortSignal;
  report(input: IssueReportInput<MessageId>): void;
}

export type TypedValidator<View, Options, MessageId extends string> = (
  view: View,
  context: ValidationContext<MessageId>,
  options: Options,
) => Promise<void> | void;

export interface TypedValidatorRegistration<
  Kind extends string,
  View,
  Options,
  MessageId extends string,
> {
  readonly descriptor: RuleDescriptor<Kind, Options, MessageId>;
  readonly validate: TypedValidator<View, Options, MessageId>;
}
