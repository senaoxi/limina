import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isPlainConfigRecord,
} from './shared';

const knipPath = ['source', 'knip'] as const;
const knipConfigKeys = new Set(['workspaces']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainConfigRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isKnipBaseDisabled(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function addMissingWorkspacesIssue(ctx: ConfigValidationContext): void {
  addConfigIssue(
    ctx,
    [...knipPath, 'workspaces'],
    'source.knip.workspaces is required when source.knip uses object form.\n  fix: Use source.knip: true for default rules, or source.knip: { workspaces: {} }.',
  );
}

function validateKnipObject(
  value: Record<string, unknown>,
  ctx: ConfigValidationContext,
): void {
  addUnknownFieldIssues({
    allowed: knipConfigKeys,
    ctx,
    message:
      'unknown source.knip config field.\n  fix: source.knip only supports the workspaces field.',
    path: [...knipPath],
    value,
  });
  if (!Object.hasOwn(value, 'workspaces')) {
    addMissingWorkspacesIssue(ctx);
    return;
  }
  if (isPlainRecord(value.workspaces)) return;
  addConfigIssue(
    ctx,
    [...knipPath, 'workspaces'],
    'source.knip.workspaces must be an object keyed by workspace package name.',
  );
}

export function validateSourceKnipConfig(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (isKnipBaseDisabled(value)) return;
  if (!isPlainRecord(value)) {
    addConfigIssue(
      ctx,
      [...knipPath],
      'source.knip must be true, false, or an object containing workspaces.',
    );
    return;
  }
  validateKnipObject(value, ctx);
}
