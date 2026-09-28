import {
  addConfigIssue,
  addUnknownFieldIssues,
  type ConfigValidationContext,
  isNonEmptyString,
  isPlainConfigRecord,
  validateRelativeSelectors,
  validateStringArrayField,
} from './shared';

const grantKeys = new Set(['include', 'reason', 'workspaceRootDependencies']);
const authorityPath = ['source', 'importAuthority'] as const;

function validateGrantFields(options: {
  ctx: ConfigValidationContext;
  grant: Record<string, unknown>;
  path: PropertyKey[];
}): void {
  addUnknownFieldIssues({
    allowed: grantKeys,
    ctx: options.ctx,
    message: 'unknown source import authority grant field.',
    path: options.path,
    value: options.grant,
  });
}

function validateGrantDependencies(options: {
  ctx: ConfigValidationContext;
  grant: Record<string, unknown>;
  path: PropertyKey[];
}): void {
  validateStringArrayField({
    ctx: options.ctx,
    path: [...options.path, 'workspaceRootDependencies'],
    required: true,
    value: options.grant.workspaceRootDependencies,
    valueName: 'workspaceRootDependencies',
  });
}

function validateGrantIncludes(options: {
  ctx: ConfigValidationContext;
  grant: Record<string, unknown>;
  path: PropertyKey[];
}): void {
  validateStringArrayField({
    ctx: options.ctx,
    path: [...options.path, 'include'],
    value: options.grant.include,
    valueName: 'include',
  });
  validateRelativeSelectors({
    ctx: options.ctx,
    message:
      'source.importAuthority allow include entries must be config.rootDir-relative paths; ../ is allowed.',
    path: [...options.path, 'include'],
    values: options.grant.include,
  });
}

function validateGrantReason(options: {
  ctx: ConfigValidationContext;
  grant: Record<string, unknown>;
  path: PropertyKey[];
}): void {
  if (isNonEmptyString(options.grant.reason)) return;
  addConfigIssue(
    options.ctx,
    [...options.path, 'reason'],
    'reason must be a non-empty string.',
  );
}

function validateGrant(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  value: unknown;
}): void {
  if (!isPlainConfigRecord(options.value)) {
    addConfigIssue(
      options.ctx,
      options.path,
      'importAuthority allow grants must be objects with workspaceRootDependencies and reason fields.',
    );
    return;
  }
  const grantOptions = {
    ctx: options.ctx,
    grant: options.value,
    path: options.path,
  };
  validateGrantFields(grantOptions);
  validateGrantDependencies(grantOptions);
  validateGrantIncludes(grantOptions);
  validateGrantReason(grantOptions);
}

function validateOwnerIdentity(options: {
  ctx: ConfigValidationContext;
  ownerIdentity: string;
  path: PropertyKey[];
}): void {
  if (options.ownerIdentity.trim().length > 0) return;
  addConfigIssue(
    options.ctx,
    options.path,
    'allow keys must be non-empty source owner identities.',
  );
}

function getOwnerGrants(options: {
  ctx: ConfigValidationContext;
  path: PropertyKey[];
  value: unknown;
}): unknown[] | null {
  if (Array.isArray(options.value)) return options.value;
  addConfigIssue(
    options.ctx,
    options.path,
    'allow owner entries must be arrays of grants.',
  );
  return null;
}

function validateOwnerGrants(options: {
  ctx: ConfigValidationContext;
  ownerIdentity: string;
  value: unknown;
}): void {
  const path = [...authorityPath, 'allow', options.ownerIdentity];
  validateOwnerIdentity({ ...options, path });
  const grants = getOwnerGrants({
    ctx: options.ctx,
    path,
    value: options.value,
  });
  if (grants === null) return;
  for (const [index, grant] of grants.entries()) {
    validateGrant({
      ctx: options.ctx,
      path: [...path, index],
      value: grant,
    });
  }
}

function getAllowMap(
  value: unknown,
  ctx: ConfigValidationContext,
): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (isPlainConfigRecord(value)) return value;
  addConfigIssue(
    ctx,
    [...authorityPath, 'allow'],
    'allow must be an object keyed by source owner identity.\n  fix: use allow: { "@scope/package": [{ include: ["test/**/*.ts"], workspaceRootDependencies: ["@example/fixture"], reason: "..." }] }.',
  );
  return null;
}

function validateAllowMap(value: unknown, ctx: ConfigValidationContext): void {
  const allow = getAllowMap(value, ctx);
  if (allow === null) return;
  for (const [ownerIdentity, grants] of Object.entries(allow)) {
    validateOwnerGrants({ ctx, ownerIdentity, value: grants });
  }
}

export function validateSourceImportAuthorityConfig(
  value: unknown,
  ctx: ConfigValidationContext,
): void {
  if (value === undefined) return;
  if (!isPlainConfigRecord(value)) {
    addConfigIssue(
      ctx,
      [...authorityPath],
      'importAuthority must be an object.',
    );
    return;
  }
  validateAllowMap(value.allow, ctx);
}
