import type { ResolvedLiminaConfig } from '#config/runner';

export interface ImplicitReferenceContext {
  config: ResolvedLiminaConfig;
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
