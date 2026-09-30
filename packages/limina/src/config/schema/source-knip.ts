import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isPlainConfigRecord,
} from './shared';

const knipPath = ['source', 'knip'] as const;
const knipConfigKeys = new Set(['root', 'workspaces']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainConfigRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isKnipBaseDisabled(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function addMissingWorkspacesIssue(context: ConfigValidationContext): void {
  addConfigIssue(
    context,
    [...knipPath],
    'source.knip must declare root or workspaces when using object form.\n  fix: Use source.knip: true for default rules, or source.knip: { workspaces: {} }.',
  );
}

function validateKnipObject(
  value: Record<string, unknown>,
  context: ConfigValidationContext,
): void {
  addUnknownFieldIssues({
    allowed: knipConfigKeys,
    ctx: context,
    message:
      'unknown source.knip config field.\n  fix: source.knip only supports root and workspaces fields.',
    path: [...knipPath],
    value,
  });
  if (!Object.hasOwn(value, 'root') && !Object.hasOwn(value, 'workspaces')) {
    addMissingWorkspacesIssue(context);
    return;
  }
  validateKnipOwnerObjects(value, context);
}

function knipOwnerObjectMessage(field: string): string {
  return field === 'root'
    ? 'source.knip.root must be an object.'
    : 'source.knip.workspaces must be an object keyed by workspace package name.';
}

function validateKnipOwnerObjects(
  value: Record<string, unknown>,
  context: ConfigValidationContext,
): void {
  for (const field of knipConfigKeys)
    validateKnipOwnerObject({ value, ctx: context, field });
}
function validateKnipOwnerObject(options: {
  value: Record<string, unknown>;
  ctx: ConfigValidationContext;
  field: string;
}): void {
  if (
    !Object.hasOwn(options.value, options.field) ||
    isPlainRecord(options.value[options.field])
  )
    return;
  const message = knipOwnerObjectMessage(options.field);
  addConfigIssue(options.ctx, [...knipPath, options.field], message);
}

export function validateSourceKnipConfig(
  value: unknown,
  context: ConfigValidationContext,
): void {
  if (isKnipBaseDisabled(value)) return;
  if (!isPlainRecord(value)) {
    addConfigIssue(
      context,
      [...knipPath],
      'source.knip must be true, false, or an object containing root or workspaces.',
    );
    return;
  }
  validateKnipObject(value, context);
}
