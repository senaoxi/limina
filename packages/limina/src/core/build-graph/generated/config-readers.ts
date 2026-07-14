import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'pathe';

import type { ResolvedLiminaConfig } from '#config/runner';
import {
  isOrdinarySourceTypecheckConfigPath,
  readJsonConfig,
  resolveReferencePath,
} from '#core/tsconfig/actions';
import { uniqueValues } from '#utils/collections';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import {
  formatUnknownValue,
  isNonEmptyString,
  isPlainRecord,
} from '#utils/values';

export interface ImplicitRef {
  path: string;
  reason: string;
  targetConfigPath: string;
}

export interface OutputOptions {
  declarationMap: boolean;
  outDir: string;
  rootDir: string;
  target: string;
}

export function isDefaultTsconfigPath(configPath: string): boolean {
  return path.basename(configPath) === 'tsconfig.json';
}

export function isDefaultSourceTsconfigPath(configPath: string): boolean {
  return (
    isOrdinarySourceTypecheckConfigPath(configPath) &&
    isDefaultTsconfigPath(configPath)
  );
}

export function isSolutionStyleTsconfig(
  configPath: string,
  configObject: Record<string, unknown>,
): boolean {
  return (
    isDefaultTsconfigPath(configPath) &&
    Array.isArray(configObject.files) &&
    configObject.files.length === 0 &&
    Object.hasOwn(configObject, 'references')
  );
}

export function readGraphRules(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
): string[] {
  const configObject = readJsonConfig(config, sourceConfigPath);
  const liminaOptions = configObject.liminaOptions;

  if (
    !liminaOptions ||
    typeof liminaOptions !== 'object' ||
    Array.isArray(liminaOptions)
  ) {
    return [];
  }

  const graphRules = (liminaOptions as { graphRules?: unknown }).graphRules;

  return Array.isArray(graphRules)
    ? uniqueValues(
        graphRules.filter(
          (label): label is string =>
            typeof label === 'string' && label.trim().length > 0,
        ),
      ).map((label) => label.trim())
    : [];
}

function addOutputOptionsProblem(options: {
  config: ResolvedLiminaConfig;
  field: string;
  problems: string[];
  reason: string;
  sourceConfigPath: string;
  value?: unknown;
}): void {
  options.problems.push(
    [
      'Invalid Limina output options:',
      `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
      `  field: ${options.field}`,
      ...(Object.hasOwn(options, 'value')
        ? [`  value: ${formatUnknownValue(options.value)}`]
        : []),
      `  reason: ${options.reason}`,
    ].join('\n'),
  );
}

function normalizeExtendsConfigPath(
  configPath: string,
  extendsValue: string,
): string | null {
  const trimmedValue = extendsValue.trim();

  if (trimmedValue.length === 0) {
    return null;
  }

  if (
    path.isAbsolute(trimmedValue) ||
    trimmedValue.startsWith('./') ||
    trimmedValue.startsWith('../')
  ) {
    const resolvedPath = path.resolve(path.dirname(configPath), trimmedValue);

    return normalizeAbsolutePath(
      path.extname(resolvedPath) ? resolvedPath : `${resolvedPath}.json`,
    );
  }

  try {
    const requireFromConfig = createRequire(configPath);

    return normalizeAbsolutePath(requireFromConfig.resolve(trimmedValue));
  } catch {
    return null;
  }
}

function readExplicitSourceCompilerTarget(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  seenConfigPaths?: Set<string>;
}): string | null {
  const seenConfigPaths = options.seenConfigPaths ?? new Set<string>();
  const configPath = normalizeAbsolutePath(options.configPath);

  if (seenConfigPaths.has(configPath) || !existsSync(configPath)) {
    return null;
  }

  seenConfigPaths.add(configPath);

  const configObject = readJsonConfig(options.config, configPath);
  const extendsValue = configObject.extends;
  const extendsValues =
    typeof extendsValue === 'string'
      ? [extendsValue]
      : Array.isArray(extendsValue)
        ? extendsValue.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : [];
  let target: string | null = null;

  for (const entry of extendsValues) {
    const extendedConfigPath = normalizeExtendsConfigPath(configPath, entry);

    if (!extendedConfigPath) {
      continue;
    }

    target =
      readExplicitSourceCompilerTarget({
        config: options.config,
        configPath: extendedConfigPath,
        seenConfigPaths,
      }) ?? target;
  }

  const compilerOptions = configObject.compilerOptions;

  if (isPlainRecord(compilerOptions)) {
    const targetValue = compilerOptions.target;

    if (isNonEmptyString(targetValue)) {
      target = targetValue.trim();
    }
  }

  return target;
}

export function readOutputOptions(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
): { outputs: OutputOptions | null; problems: string[] } {
  const configObject = readJsonConfig(config, sourceConfigPath);
  const liminaOptions = configObject.liminaOptions;
  const problems: string[] = [];

  if (liminaOptions === undefined) {
    return {
      outputs: null,
      problems,
    };
  }

  if (!isPlainRecord(liminaOptions)) {
    addOutputOptionsProblem({
      config,
      field: 'liminaOptions',
      problems,
      reason: 'liminaOptions must be an object before outputs can be read.',
      sourceConfigPath,
      value: liminaOptions,
    });
    return {
      outputs: null,
      problems,
    };
  }

  const outputs = liminaOptions.outputs;

  if (outputs === undefined) {
    return {
      outputs: null,
      problems,
    };
  }

  if (!isPlainRecord(outputs)) {
    addOutputOptionsProblem({
      config,
      field: 'liminaOptions.outputs',
      problems,
      reason: 'outputs must be an object.',
      sourceConfigPath,
      value: outputs,
    });
    return {
      outputs: null,
      problems,
    };
  }

  const stringFields = new Set(['outDir', 'rootDir', 'target']);
  const booleanFields = new Set(['declarationMap']);
  const allowedFields = new Set([...stringFields, ...booleanFields]);

  for (const fieldName of Object.keys(outputs)) {
    if (!allowedFields.has(fieldName)) {
      addOutputOptionsProblem({
        config,
        field: `liminaOptions.outputs.${fieldName}`,
        problems,
        reason:
          'outputs only supports target, rootDir, outDir, and declarationMap.',
        sourceConfigPath,
        value: outputs[fieldName],
      });
    }
  }

  const outputValues: Record<string, string> = {};

  for (const fieldName of stringFields) {
    const fieldValue = outputs[fieldName];

    if (fieldValue === undefined) {
      continue;
    }

    if (!isNonEmptyString(fieldValue)) {
      addOutputOptionsProblem({
        config,
        field: `liminaOptions.outputs.${fieldName}`,
        problems,
        reason: 'output option fields must be non-empty strings.',
        sourceConfigPath,
        value: fieldValue,
      });
      continue;
    }

    if (
      (fieldName === 'rootDir' || fieldName === 'outDir') &&
      path.isAbsolute(fieldValue)
    ) {
      addOutputOptionsProblem({
        config,
        field: `liminaOptions.outputs.${fieldName}`,
        problems,
        reason:
          'output path fields must be relative to the tsconfig that declares them.',
        sourceConfigPath,
        value: fieldValue,
      });
      continue;
    }

    outputValues[fieldName] = fieldValue.trim();
  }

  const declarationMapValue = outputs.declarationMap;
  let declarationMap = false;

  if (declarationMapValue !== undefined) {
    if (typeof declarationMapValue === 'boolean') {
      declarationMap = declarationMapValue;
    } else {
      addOutputOptionsProblem({
        config,
        field: 'liminaOptions.outputs.declarationMap',
        problems,
        reason: 'declarationMap must be a boolean.',
        sourceConfigPath,
        value: declarationMapValue,
      });
    }
  }

  if (problems.length > 0) {
    return {
      outputs: null,
      problems,
    };
  }

  const sourceConfigDirectory = path.dirname(sourceConfigPath);
  const target =
    outputValues.target ??
    readExplicitSourceCompilerTarget({
      config,
      configPath: sourceConfigPath,
    }) ??
    'ESNext';

  return {
    outputs: {
      declarationMap,
      target,
      rootDir: normalizeAbsolutePath(
        path.resolve(sourceConfigDirectory, outputValues.rootDir ?? '.'),
      ),
      outDir: normalizeAbsolutePath(
        path.resolve(sourceConfigDirectory, outputValues.outDir ?? './dist'),
      ),
    },
    problems,
  };
}

function addImplicitRefProblem(options: {
  config: ResolvedLiminaConfig;
  field: string;
  problems: string[];
  reason: string;
  sourceConfigPath: string;
  value?: unknown;
}): void {
  options.problems.push(
    [
      'Invalid Limina implicit reference:',
      `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
      `  field: ${options.field}`,
      ...(Object.hasOwn(options, 'value')
        ? [`  value: ${formatUnknownValue(options.value)}`]
        : []),
      `  reason: ${options.reason}`,
    ].join('\n'),
  );
}

export function readImplicitRefs(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
): { implicitRefs: ImplicitRef[]; problems: string[] } {
  const configObject = readJsonConfig(config, sourceConfigPath);
  const liminaOptions = configObject.liminaOptions;
  const problems: string[] = [];
  const implicitRefsByTarget = new Map<string, ImplicitRef>();

  if (liminaOptions === undefined) {
    return {
      implicitRefs: [],
      problems,
    };
  }

  if (!isPlainRecord(liminaOptions)) {
    addImplicitRefProblem({
      config,
      field: 'liminaOptions',
      problems,
      reason:
        'liminaOptions must be an object before implicitRefs can be read.',
      sourceConfigPath,
      value: liminaOptions,
    });
    return {
      implicitRefs: [],
      problems,
    };
  }

  const implicitRefs = liminaOptions.implicitRefs;

  if (implicitRefs === undefined) {
    return {
      implicitRefs: [],
      problems,
    };
  }

  if (!Array.isArray(implicitRefs)) {
    addImplicitRefProblem({
      config,
      field: 'liminaOptions.implicitRefs',
      problems,
      reason:
        'implicitRefs must be an array of objects with non-empty path and reason fields.',
      sourceConfigPath,
      value: implicitRefs,
    });
    return {
      implicitRefs: [],
      problems,
    };
  }

  for (const [index, entry] of implicitRefs.entries()) {
    const field = `liminaOptions.implicitRefs[${index}]`;

    if (!isPlainRecord(entry)) {
      addImplicitRefProblem({
        config,
        field,
        problems,
        reason:
          'implicitRefs entries must be objects with non-empty path and reason fields.',
        sourceConfigPath,
        value: entry,
      });
      continue;
    }

    const pathValue = entry.path;
    const reasonValue = entry.reason;

    if (!isNonEmptyString(pathValue)) {
      addImplicitRefProblem({
        config,
        field: `${field}.path`,
        problems,
        reason: 'implicitRefs path is required and must be a non-empty string.',
        sourceConfigPath,
        value: pathValue,
      });
      continue;
    }

    if (path.isAbsolute(pathValue)) {
      addImplicitRefProblem({
        config,
        field: `${field}.path`,
        problems,
        reason:
          'implicitRefs path must be relative to the tsconfig that declares it.',
        sourceConfigPath,
        value: pathValue,
      });
      continue;
    }

    if (!isNonEmptyString(reasonValue)) {
      addImplicitRefProblem({
        config,
        field: `${field}.reason`,
        problems,
        reason:
          'implicitRefs reason is required and must be a non-empty string.',
        sourceConfigPath,
        value: reasonValue,
      });
      continue;
    }

    const targetConfigPath = resolveReferencePath(
      sourceConfigPath,
      pathValue.trim(),
    );

    if (targetConfigPath === sourceConfigPath) {
      addImplicitRefProblem({
        config,
        field: `${field}.path`,
        problems,
        reason: 'implicitRefs must not reference the declaring tsconfig.',
        sourceConfigPath,
        value: pathValue,
      });
      continue;
    }

    if (!existsSync(targetConfigPath)) {
      addImplicitRefProblem({
        config,
        field: `${field}.path`,
        problems,
        reason:
          'implicitRefs path must point to an existing ordinary source tsconfig.',
        sourceConfigPath,
        value: pathValue,
      });
      continue;
    }

    if (!isOrdinarySourceTypecheckConfigPath(targetConfigPath)) {
      addImplicitRefProblem({
        config,
        field: `${field}.path`,
        problems,
        reason:
          'implicitRefs path must point to an ordinary source tsconfig*.json file, not a generated, declaration, build, base, or check config.',
        sourceConfigPath,
        value: pathValue,
      });
      continue;
    }

    if (implicitRefsByTarget.has(targetConfigPath)) {
      continue;
    }

    implicitRefsByTarget.set(targetConfigPath, {
      path: pathValue.trim(),
      reason: reasonValue.trim(),
      targetConfigPath,
    });
  }

  return {
    implicitRefs: [...implicitRefsByTarget.values()],
    problems,
  };
}

export function addSourceReferenceConfigProblems(options: {
  config: ResolvedLiminaConfig;
  problems: string[];
  sourceConfigPath: string;
}): void {
  const configObject = readJsonConfig(options.config, options.sourceConfigPath);

  if (!Object.hasOwn(configObject, 'references')) {
    return;
  }

  if (isSolutionStyleTsconfig(options.sourceConfigPath, configObject)) {
    return;
  }

  options.problems.push(
    [
      'Source typecheck config declares project references:',
      `  config: ${toRelativePath(options.config.rootDir, options.sourceConfigPath)}`,
      '  field: references',
      '  reason: source typecheck configs must not hand-maintain project references; Limina infers static source edges and liminaOptions.implicitRefs documents dynamic or virtual edges.',
      '  fix: remove obsolete tsc -b references from source configs, move IDE aggregation references to a files: [] solution tsconfig.json, or replace dynamic source edges with liminaOptions.implicitRefs.',
    ].join('\n'),
  );
}

export function readRelativeTypeFiles(
  config: ResolvedLiminaConfig,
  sourceConfigPath: string,
): string[] {
  const configObject = readJsonConfig(config, sourceConfigPath);
  const compilerOptions = configObject.compilerOptions;

  if (
    !compilerOptions ||
    typeof compilerOptions !== 'object' ||
    Array.isArray(compilerOptions)
  ) {
    return [];
  }

  const types = (compilerOptions as { types?: unknown }).types;

  if (!Array.isArray(types)) {
    return [];
  }

  return types
    .filter(
      (typeName): typeName is string =>
        typeof typeName === 'string' &&
        (typeName.startsWith('./') || typeName.startsWith('../')),
    )
    .map((typeName) =>
      normalizeAbsolutePath(
        path.resolve(path.dirname(sourceConfigPath), typeName),
      ),
    );
}

export function collectTypeRootCandidates(options: {
  rootDir: string;
  sourceConfigPath: string;
}): string[] {
  const candidates: string[] = [];
  let currentDir = path.dirname(options.sourceConfigPath);

  for (;;) {
    const nodeModulesDir = path.join(currentDir, 'node_modules');
    const nodeModulesTypesDir = path.join(nodeModulesDir, '@types');

    if (existsSync(nodeModulesDir)) {
      candidates.push(nodeModulesDir);
    }

    if (existsSync(nodeModulesTypesDir)) {
      candidates.push(nodeModulesTypesDir);
    }

    if (currentDir === options.rootDir) {
      break;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return uniqueValues(candidates);
}
