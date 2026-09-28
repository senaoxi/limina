import type { ResolvedLiminaConfig } from 'limina/internal/migration';
import {
  createLiminaTsconfigSchemaPath,
  isPlainRecord,
  type JsonObject,
} from 'limina/internal/migration';
import path from 'pathe';
import {
  assertMigrationTextMatchesPlan,
  assertUnambiguousMigrationText,
} from './jsonc-validation';
import {
  applyMigratedTsconfigText,
  collectMigrationEdits,
} from './text-transform';
import type { MigrationWritePlanItem } from './transaction';
import type { MigrationEffectiveConfig, MigrationTarget } from './types';

export function relativeConfigPath(configPath: string, target: string): string {
  const relative = path.relative(path.dirname(configPath), target) || '.';
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function hasExistingOutputs(target: MigrationTarget): boolean {
  const metadata = target.configObject.liminaOptions;
  return isPlainRecord(metadata) && Object.hasOwn(metadata, 'outputs');
}

function hasSplitOutputs(
  options: MigrationEffectiveConfig['options'],
): boolean {
  if (!options.declarationDir || !options.outDir) return false;
  return path.resolve(options.declarationDir) !== path.resolve(options.outDir);
}

export function outputAdoptionRejectionReason(
  target: MigrationTarget,
): string | undefined {
  const options = target.effectiveConfig.options;
  const reasons: [boolean, string][] = [
    [
      target.isTypeScriptSolution,
      'Solution compiler options do not enable managed output.',
    ],
    [
      hasExistingOutputs(target),
      'Preserved the existing explicit output contract.',
    ],
    [
      options.noEmit === true,
      'Effective noEmit is true; managed emit was not enabled.',
    ],
    [
      Boolean(options.emitDeclarationOnly),
      'Declaration-only emission was not adopted.',
    ],
    [Boolean(options.outFile), 'outFile emission was not adopted.'],
    [
      hasSplitOutputs(options),
      'Split declaration and JavaScript directories were not adopted.',
    ],
    [!options.outDir, 'No effective outDir supplies automatic output intent.'],
  ];
  return reasons.find(([reject]) => reject)?.[1];
}

/** Optional proposal only. The planner must check visibility and membership. */
export function proposeOutputAdoption(
  target: MigrationTarget,
): JsonObject | undefined {
  if (outputAdoptionRejectionReason(target)) return undefined;
  return createOutputProposal(target);
}

function createOutputProposal(target: MigrationTarget): JsonObject {
  const options = target.effectiveConfig.options;
  const output: JsonObject = {
    outDir: relativeConfigPath(target.configPath, options.outDir!),
  };
  if (options.rootDir)
    output.rootDir = relativeConfigPath(target.configPath, options.rootDir);
  if (options.declarationMap !== undefined)
    output.declarationMap = options.declarationMap;
  return output;
}

export function migrateTsconfigObject(options: {
  configObject: JsonObject;
  configPath: string;
  effectiveConfig?: MigrationEffectiveConfig;
  isLiminaSolution: boolean;
  rootDir: string;
}): JsonObject {
  const next = structuredClone(options.configObject);
  next.$schema = createLiminaTsconfigSchemaPath(
    options.rootDir,
    options.configPath,
  );
  if (!options.isLiminaSolution) delete next.references;
  return next;
}

export function createMigrationWritePlanItem(options: {
  config: ResolvedLiminaConfig;
  target: MigrationTarget;
  migratedConfig?: JsonObject;
}): MigrationWritePlanItem {
  const next =
    options.migratedConfig ??
    migrateTsconfigObject({
      ...options.target,
      rootDir: options.config.rootDir,
    });
  const edits = collectMigrationEdits(options.target.configObject, next);
  assertUnambiguousMigrationText(
    options.target.originalContent,
    edits.map((edit) => edit.path),
  );
  const nextContent = applyMigratedTsconfigText({
    ...options.target,
    migratedConfig: next,
  });
  assertMigrationTextMatchesPlan(nextContent, next);
  return {
    configPath: options.target.configPath,
    nextContent,
    originalBytes: options.target.originalBytes,
    originalContent: options.target.originalContent,
    status:
      options.target.originalContent === nextContent ? 'skipped' : 'modified',
  };
}
