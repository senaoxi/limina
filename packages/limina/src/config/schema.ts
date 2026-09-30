import type { LiminaConfig } from '#config/runner';
import { ConfigError } from '../domain/validation/errors';
import { formatLiminaConfigShapeIssue } from './schema/format';
import { liminaConfigShapeSchema } from './schema/root';

function collectLiminaConfigShapeProblems(value: unknown): string[] {
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
