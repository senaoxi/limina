import type { LiminaConfig } from '#config/runner';
import { ConfigError } from '../domain/validation/errors';
import { formatLiminaConfigShapeIssue } from './schema/format';
import { governanceDataSchema } from './schema/governance-data';
import { legacyConfigProblems } from './schema/legacy';
import { liminaConfigShapeSchema } from './schema/root';

function collectLiminaConfigShapeProblems(value: unknown): string[] {
  const data = governanceDataSchema.safeParse(value);
  // Never read a rejected accessor or proxy while formatting its diagnostic.
  if (!data.success)
    return data.error.issues.map((issue) =>
      formatLiminaConfigShapeIssue(undefined, issue),
    );
  const legacy = legacyConfigProblems(value);
  return legacy.length > 0 ? legacy : collectShapeProblems(value);
}

function collectShapeProblems(value: unknown): string[] {
  const result = liminaConfigShapeSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) =>
        formatLiminaConfigShapeIssue(value, issue),
      );
}

export function validateLiminaConfig(config: LiminaConfig): void {
  const problems = collectLiminaConfigShapeProblems(config);
  if (problems.length === 0) return;
  throw new ConfigError(
    problems.join('\n\n'),
    problems.map((message) => ({ message, path: [] })),
  );
}
