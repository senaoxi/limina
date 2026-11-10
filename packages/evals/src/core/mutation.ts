import { parseAllDocuments } from 'yaml';
import { assertTaskCaptureScope } from './capture-policy.ts';
import { canonicalJson, contentIdentity } from './identity.ts';
import type { FileChange, Snapshot, SnapshotEntry } from './snapshot.ts';
import {
  assertRelativePath,
  compareAgentSnapshots,
  verifySnapshot,
} from './snapshot.ts';
import {
  isPipelineAuthorized,
  isStaticLiminaConfig,
  readStaticLiminaConfig,
} from './static-config.ts';
import type {
  DependencyInput,
  DependencyVariant,
  MutationRule,
  TaskSpec,
} from './task.ts';

export interface MutationViolation {
  path: string;
  code:
    | 'protected'
    | 'unauthorized_path'
    | 'file_type'
    | 'mode'
    | 'json_field'
    | 'dependency_inputs'
    | 'invalid_input';
}

export type MutationDecision =
  | {
      status: 'accepted';
      changes: FileChange[];
      dependencyVariant: DependencyVariant;
    }
  | { status: 'unsafe'; violations: MutationViolation[] }
  | { status: 'unknown'; reason: string };

const lifecycleScripts = [
  'pnpm:devPreinstall',
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'preprepare',
  'postprepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
];
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
  'overrides',
  'resolutions',
  'pnpm',
  'packageManager',
  'engines',
  'devEngines',
  'workspaces',
  'config',
];
const reservedRoots = ['.agents', '__agent_eval__'];

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function decodeFile(entry: SnapshotEntry): string {
  if (entry.kind !== 'file')
    throw new Error('Installation input must be a regular file');
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.from(entry.content, 'base64'),
  );
}

function parseInput(
  entry: SnapshotEntry,
  format: DependencyInput['format'],
): unknown {
  const text = decodeFile(entry);
  if (format !== 'yaml') return JSON.parse(text) as unknown;
  const documents = parseAllDocuments(text, { uniqueKeys: true, merge: false });
  if (
    documents.some(
      (document) => document.errors.length > 0 || document.warnings.length > 0,
    )
  )
    throw new Error('Invalid installation YAML');
  // pnpm 12 stores manager and project locks in separate YAML documents.
  // Every document and its order participate in the authorized input identity.
  return documents.map(
    (document) => document.toJS({ maxAliasCount: 0 }) as unknown,
  );
}

function manifestInstallationInputs(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Manifest must be an object');
  const manifest = value as Record<string, unknown>;
  const fields = Object.fromEntries(
    dependencyFields
      .filter((key) => Object.hasOwn(manifest, key))
      .map((key) => [key, manifest[key]]),
  );
  if (manifest.scripts !== undefined) {
    if (
      typeof manifest.scripts !== 'object' ||
      manifest.scripts === null ||
      Array.isArray(manifest.scripts)
    )
      throw new Error('Invalid manifest scripts');
    const scripts = manifest.scripts as Record<string, unknown>;
    const hooks = lifecycleScripts.filter((key) => Object.hasOwn(scripts, key));
    if (hooks.length > 0)
      fields.scripts = Object.fromEntries(
        hooks.map((key) => [key, scripts[key]]),
      );
  }
  return fields;
}

/**
Used by prepare on trusted variants and by validation on captured Agent input.
*/
export function dependencyInputsIdentity(
  snapshot: Snapshot,
  inputs: DependencyInput[],
): string {
  verifySnapshot(snapshot);
  const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  const values: Record<string, unknown> = {};
  for (const input of inputs) {
    assertRelativePath(input.path);
    if (seen.has(input.path)) throw new Error('Duplicate installation input');
    seen.add(input.path);
    const entry = entries.get(input.path);
    const value = entry ? parseInput(entry, input.format) : null;
    Object.defineProperty(values, input.path, {
      value:
        entry && input.format === 'manifest'
          ? manifestInstallationInputs(value)
          : value,
      enumerable: true,
    });
  }
  return contentIdentity(values);
}

function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function changedJsonFields(
  before: unknown,
  after: unknown,
  pointer = '',
): string[] {
  if (
    before !== undefined &&
    after !== undefined &&
    canonicalJson(before) === canonicalJson(after)
  )
    return [];
  const isBeforeObject = isJsonObject(before);
  const isAfterObject = isJsonObject(after);
  const normalizedBefore =
    before === undefined && isAfterObject && Object.keys(after).length > 0
      ? {}
      : before;
  const normalizedAfter =
    after === undefined && isBeforeObject && Object.keys(before).length > 0
      ? {}
      : after;
  if (!isJsonObject(normalizedBefore) || !isJsonObject(normalizedAfter))
    return [pointer];
  const a = normalizedBefore as Record<string, unknown>;
  const b = normalizedAfter as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) =>
    changedJsonFields(
      Object.hasOwn(a, key) ? a[key] : undefined,
      Object.hasOwn(b, key) ? b[key] : undefined,
      `${pointer}/${escapePointer(key)}`,
    ),
  );
}

function checkRule(
  change: FileChange,
  rule: MutationRule,
): MutationViolation | undefined {
  const operation = change.before
    ? change.after
      ? 'modify'
      : 'delete'
    : 'add';
  if (!rule.operations.includes(operation))
    return { path: change.path, code: 'unauthorized_path' };
  if (change.before && change.after && change.before.kind !== change.after.kind)
    return { path: change.path, code: 'file_type' };
  if (
    change.after &&
    ((change.after.mode & 0o7000) !== 0 ||
      (change.after.kind === 'file' &&
        (change.after.mode & 0o111) !== 0 &&
        !rule.allowExecutable))
  )
    return { path: change.path, code: 'mode' };
  return change.before &&
    change.after &&
    change.before.mode !== change.after.mode &&
    !rule.allowExecutable
    ? { path: change.path, code: 'mode' }
    : checkRuleContent(change, rule);
}

function checkRuleContent(
  change: FileChange,
  rule: MutationRule,
): MutationViolation | undefined {
  if (rule.pipelinePolicy) {
    try {
      const config =
        rule.content === 'static-limina-config' && change.after
          ? readStaticLiminaConfig(decodeFile(change.after))
          : null;
      if (!config || !isPipelineAuthorized(config, rule.pipelinePolicy))
        return { path: change.path, code: 'invalid_input' };
    } catch {
      return { path: change.path, code: 'invalid_input' };
    }
  }
  if (!rule.jsonFields) return undefined;
  try {
    const parse = (entry: SnapshotEntry): unknown => {
      const content = decodeFile(entry);
      if (rule.content !== 'static-limina-config')
        return JSON.parse(content) as unknown;
      const config = readStaticLiminaConfig(content);
      if (!config) throw new Error('Invalid static config');
      return config;
    };
    const before = change.before ? parse(change.before) : {};
    const after = change.after ? parse(change.after) : {};
    const fields = changedJsonFields(before, after);
    if (
      fields.some(
        (field) =>
          !rule.jsonFields?.some(
            (allowed) => field === allowed || field.startsWith(`${allowed}/`),
          ),
      )
    )
      return { path: change.path, code: 'json_field' };
  } catch {
    return { path: change.path, code: 'invalid_input' };
  }
  return undefined;
}

function isInstallationPath(path: string): boolean {
  const name = path.split('/').at(-1);
  return [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    '.pnpmfile.cjs',
    '.pnpmfile.mjs',
    'package-lock.json',
    'yarn.lock',
  ].includes(name ?? '');
}

/**
No project code, package manager or project configuration is executed here.
*/
export function validateMutations(
  task: TaskSpec,
  start: Snapshot,
  final: Snapshot,
): MutationDecision {
  let changes: FileChange[];
  try {
    assertTaskCaptureScope(task, start);
    assertTaskCaptureScope(task, final);
    changes = compareAgentSnapshots(start, final);
  } catch {
    return { status: 'unknown', reason: 'incomplete_or_invalid_capture' };
  }
  const violations: MutationViolation[] = [];
  for (const change of changes) {
    if (
      [...reservedRoots, ...task.mutationPolicy.protectedRoots].some((root) =>
        isWithin(change.path, root),
      )
    ) {
      violations.push({ path: change.path, code: 'protected' });
      continue;
    }
    if (change.before?.kind === 'symlink' || change.after?.kind === 'symlink') {
      violations.push({ path: change.path, code: 'file_type' });
      continue;
    }
    const rule = task.mutationPolicy.rules.find((candidate) =>
      candidate.descendants
        ? isWithin(change.path, candidate.path)
        : change.path === candidate.path,
    );
    if (!rule) {
      violations.push({ path: change.path, code: 'unauthorized_path' });
      continue;
    }
    const violation = checkRule(change, rule);
    if (violation) violations.push(violation);
    if (rule.content === 'static-limina-config' && change.after) {
      try {
        if (!isStaticLiminaConfig(decodeFile(change.after)))
          violations.push({ path: change.path, code: 'invalid_input' });
      } catch {
        violations.push({ path: change.path, code: 'invalid_input' });
      }
    }
    if (
      isInstallationPath(change.path) &&
      task.dependencyPolicy.inputs.every((input) => input.path !== change.path)
    )
      violations.push({ path: change.path, code: 'dependency_inputs' });
  }
  if (violations.length > 0) return { status: 'unsafe', violations };
  try {
    const digest = dependencyInputsIdentity(
      final,
      task.dependencyPolicy.inputs,
    );
    const dependencyVariant = task.dependencyPolicy.variants.find(
      (variant) => variant.inputsDigest === digest,
    );
    if (!dependencyVariant)
      return {
        status: 'unsafe',
        violations: [{ path: '', code: 'dependency_inputs' }],
      };
    return { status: 'accepted', changes, dependencyVariant };
  } catch {
    return {
      status: 'unsafe',
      violations: [{ path: '', code: 'invalid_input' }],
    };
  }
}
