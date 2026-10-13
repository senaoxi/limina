import type { ResolvedLiminaInputs } from '#config/runner';

export interface ImplicitReferenceContext {
  config: ResolvedLiminaInputs;
  problems: string[];
  sourceConfigPath: string;
}

export type ImplicitReferenceEntriesResult =
  | { kind: 'absent' | 'invalid' }
  | { entries: unknown[]; kind: 'value' };

export interface ReferenceTargetValidationOptions {
  rootDir: string;
  sourceConfigPath: string;
  targetConfigPath: string;
}

export type ReferenceTargetValidator = (
  options: ReferenceTargetValidationOptions,
) => string | null;
