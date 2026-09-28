import type { LiminaConfig } from '#config/runner';
import { ConfigurationError } from '../domain/validation/errors';
import { formatLiminaConfigShapeIssue } from './schema/format';
import { liminaConfigShapeSchema } from './schema/root';

function collectLiminaConfigShapeProblems(value: unknown): string[] {
  const result = liminaConfigShapeSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) =>
    formatLiminaConfigShapeIssue(value, issue),
  );
}

export function validateLiminaConfig(config: LiminaConfig): void {
  const problems = collectLiminaConfigShapeProblems(config);
  if (problems.length === 0) return;
  throw new ConfigurationError(
    problems.join('\n\n'),
    problems.map((message) => ({ message, path: [] })),
  );
}
