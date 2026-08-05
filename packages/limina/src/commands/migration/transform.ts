import type { ResolvedLiminaConfig } from '#config/runner';
import {
  createLiminaTsconfigSchemaPath,
  type JsonObject,
} from '#core/tsconfig/actions';
import { toRelativePath } from '#utils/path';
import { formatUnknownValue, isPlainRecord } from '#utils/values';
import {
  planDeclarationDir,
  readExistingOutputOptions,
} from './declaration-dir';
import { applyMigratedTsconfigText } from './text-transform';
import type { MigrationWritePlanItem } from './transaction';
import type { MigrationEffectiveConfig, MigrationTarget } from './types';

type CompilerOutputField = 'declarationMap' | 'outDir' | 'rootDir' | 'target';

const compilerOutputFields: readonly CompilerOutputField[] = [
  'outDir',
  'rootDir',
  'declarationMap',
  'target',
];
const governedCompilerOptionFields = [
  'composite',
  'declaration',
  'emitDeclarationOnly',
  'incremental',
  'noEmit',
  'tsBuildInfoFile',
] as const;

function getEffectiveConfig(
  effectiveConfig: MigrationEffectiveConfig | undefined,
): MigrationEffectiveConfig {
  return effectiveConfig ?? { fileNames: [], options: {} };
}

function assertPlainObjectField(options: {
  configPath: string;
  field: string;
  rootDir: string;
  value: unknown;
}): Record<string, unknown> {
  if (isPlainRecord(options.value)) {
    return options.value;
  }
  throw new Error(
    [
      'Unable to migrate tsconfig field:',
      `  config: ${toRelativePath(options.rootDir, options.configPath)}`,
      `  field: ${options.field}`,
      `  value: ${formatUnknownValue(options.value)}`,
      '  reason: this field must be an object before Limina can merge migration output into it.',
    ].join('\n'),
  );
}

function readMergeRecord(options: {
  configPath: string;
  field: string;
  rootDir: string;
  value: unknown;
}): Record<string, unknown> {
  return options.value === undefined
    ? {}
    : {
        ...assertPlainObjectField(options),
      };
}

function mergeOutputOptions(options: {
  configPath: string;
  movedOutputs: Record<string, unknown>;
  rootDir: string;
  tsconfig: JsonObject;
}): void {
  if (Object.keys(options.movedOutputs).length === 0) {
    return;
  }
  const liminaOptions = readMergeRecord({
    configPath: options.configPath,
    field: 'liminaOptions',
    rootDir: options.rootDir,
    value: options.tsconfig.liminaOptions,
  });
  const outputs = readMergeRecord({
    configPath: options.configPath,
    field: 'liminaOptions.outputs',
    rootDir: options.rootDir,
    value: liminaOptions.outputs,
  });
  options.tsconfig.liminaOptions = {
    ...liminaOptions,
    outputs: { ...outputs, ...options.movedOutputs },
  };
}

function moveCompilerOutputs(
  compilerOptions: Record<string, unknown>,
): Record<string, unknown> {
  const movedOutputs: Record<string, unknown> = {};
  for (const field of compilerOutputFields) {
    if (Object.hasOwn(compilerOptions, field)) {
      movedOutputs[field] = compilerOptions[field];
      delete compilerOptions[field];
    }
  }
  return movedOutputs;
}

function removeGovernedCompilerOptions(
  compilerOptions: Record<string, unknown>,
): void {
  for (const field of governedCompilerOptionFields) {
    delete compilerOptions[field];
  }
}

function readDirectCompilerOptions(options: {
  configPath: string;
  rootDir: string;
  tsconfig: JsonObject;
}): Record<string, unknown> {
  if (options.tsconfig.compilerOptions === undefined) return {};
  return {
    ...assertPlainObjectField({
      configPath: options.configPath,
      field: 'compilerOptions',
      rootDir: options.rootDir,
      value: options.tsconfig.compilerOptions,
    }),
  };
}

function applyDeclarationDirPlan(
  compilerOptions: Record<string, unknown>,
  removeDeclarationDir: boolean,
): void {
  if (removeDeclarationDir) delete compilerOptions.declarationDir;
}

function writeCompilerOptions(
  tsconfig: JsonObject,
  compilerOptions: Record<string, unknown>,
): void {
  if (Object.keys(compilerOptions).length === 0) {
    delete tsconfig.compilerOptions;
    return;
  }
  tsconfig.compilerOptions = compilerOptions;
}

function migrateCompilerOptions(options: {
  configPath: string;
  effectiveConfig: MigrationEffectiveConfig;
  isSolutionStyle: boolean;
  rootDir: string;
  tsconfig: JsonObject;
}): { movedOutputs: Record<string, unknown> } {
  const compilerOptions = readDirectCompilerOptions(options);
  const directOutDir = compilerOptions.outDir;
  const movedOutputs = moveCompilerOutputs(compilerOptions);
  const plan = planDeclarationDir({
    compilerOptions,
    configPath: options.configPath,
    directOutDir,
    effectiveConfig: options.effectiveConfig,
    existingOutputs: readExistingOutputOptions(options.tsconfig),
    isSolutionStyle: options.isSolutionStyle,
    movedOutputs,
    rootDir: options.rootDir,
  });
  removeGovernedCompilerOptions(compilerOptions);
  applyDeclarationDirPlan(compilerOptions, plan.removeDeclarationDir);
  writeCompilerOptions(options.tsconfig, compilerOptions);
  return { movedOutputs: plan.movedOutputs };
}

function removeSourceReferences(
  tsconfig: JsonObject,
  isSolutionStyle: boolean,
): void {
  if (!isSolutionStyle && Object.hasOwn(tsconfig, 'references')) {
    delete tsconfig.references;
  }
}

function applySchema(options: {
  configPath: string;
  rootDir: string;
  tsconfig: JsonObject;
}): JsonObject {
  const rest = { ...options.tsconfig };
  delete rest.$schema;
  return {
    $schema: createLiminaTsconfigSchemaPath(
      options.rootDir,
      options.configPath,
    ),
    ...rest,
  };
}

export function migrateTsconfigObject(options: {
  configObject: JsonObject;
  configPath: string;
  effectiveConfig?: MigrationEffectiveConfig;
  isSolutionStyle: boolean;
  rootDir: string;
}): JsonObject {
  const nextConfig: JsonObject = { ...options.configObject };
  const migration = migrateCompilerOptions({
    configPath: options.configPath,
    effectiveConfig: getEffectiveConfig(options.effectiveConfig),
    isSolutionStyle: options.isSolutionStyle,
    rootDir: options.rootDir,
    tsconfig: nextConfig,
  });
  if (!options.isSolutionStyle) {
    mergeOutputOptions({
      configPath: options.configPath,
      movedOutputs: migration.movedOutputs,
      rootDir: options.rootDir,
      tsconfig: nextConfig,
    });
  }
  removeSourceReferences(nextConfig, options.isSolutionStyle);
  return applySchema({
    configPath: options.configPath,
    rootDir: options.rootDir,
    tsconfig: nextConfig,
  });
}

function migrateTsconfigText(options: {
  configObject: JsonObject;
  configPath: string;
  effectiveConfig?: MigrationEffectiveConfig;
  isSolutionStyle: boolean;
  originalContent: string;
  rootDir: string;
}): string {
  const migratedConfig = migrateTsconfigObject(options);
  return applyMigratedTsconfigText({
    configObject: options.configObject,
    isSolutionStyle: options.isSolutionStyle,
    migratedConfig,
    originalContent: options.originalContent,
  });
}

export function createMigrationWritePlanItem(options: {
  config: ResolvedLiminaConfig;
  target: MigrationTarget;
}): MigrationWritePlanItem {
  const nextContent = migrateTsconfigText({
    configObject: options.target.configObject,
    configPath: options.target.configPath,
    effectiveConfig: options.target.effectiveConfig,
    isSolutionStyle: options.target.isSolutionStyle,
    originalContent: options.target.originalContent,
    rootDir: options.config.rootDir,
  });
  return {
    configPath: options.target.configPath,
    nextContent,
    originalBytes: options.target.originalBytes,
    originalContent: options.target.originalContent,
    status:
      options.target.originalContent === nextContent ? 'skipped' : 'modified',
  };
}
