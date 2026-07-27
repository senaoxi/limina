import type { ResolvedLiminaConfig } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import type { SourceFinding } from './findings';

export type AmbientDeclarationRule = NonNullable<
  NonNullable<
    NonNullable<ResolvedLiminaConfig['source']>['declarations']
  >['ambient']
>[number];

export interface AmbientDeclarationPolicy {
  allowSharedAcrossOwners: boolean;
  allowTripleSlashReferences: boolean;
  filePath: string;
  reason: string;
  ruleIndex: number;
}

export interface AmbientDeclarationIndex {
  get(filePath: string): AmbientDeclarationPolicy | null;
  has(filePath: string): boolean;
}

export interface AmbientDeclarationIndexResult {
  index: AmbientDeclarationIndex;
  issues: SourceFinding[];
}

export type AmbientDeclarationViolationKind =
  | 'managed-output'
  | 'not-ambient-role'
  | 'not-declaration-file'
  | 'public-declaration-entry';

export interface AmbientDeclarationViolation {
  kind: AmbientDeclarationViolationKind;
  reason: string;
}

export interface AmbientRuleMatch {
  matches: string[];
  rule: AmbientDeclarationRule;
  ruleIndex: number;
}

export class AmbientDeclarationIndexImpl implements AmbientDeclarationIndex {
  readonly #policies: Map<string, AmbientDeclarationPolicy>;

  constructor(policies: Iterable<readonly [string, AmbientDeclarationPolicy]>) {
    this.#policies = new Map(policies);
  }

  get(filePath: string): AmbientDeclarationPolicy | null {
    const policy = this.#policies.get(normalizeAbsolutePath(filePath));
    return policy === undefined ? null : policy;
  }

  has(filePath: string): boolean {
    return this.#policies.has(normalizeAbsolutePath(filePath));
  }
}
