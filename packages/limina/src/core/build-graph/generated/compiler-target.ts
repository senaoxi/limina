import type { ResolvedLiminaConfig } from '#config/runner';
import { readJsonConfig } from '#core/tsconfig/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { isNonEmptyString, isPlainRecord } from '#utils/values';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'pathe';

function isPathLikeExtends(value: string): boolean {
  return (
    path.isAbsolute(value) || value.startsWith('./') || value.startsWith('../')
  );
}

function normalizeLocalExtendsPath(
  configPath: string,
  extendsValue: string,
): string {
  const resolvedPath = path.resolve(path.dirname(configPath), extendsValue);
  const filePath = path.extname(resolvedPath)
    ? resolvedPath
    : `${resolvedPath}.json`;
  return normalizeAbsolutePath(filePath);
}

function resolvePackageExtendsPath(
  configPath: string,
  extendsValue: string,
): string | null {
  try {
    return normalizeAbsolutePath(
      createRequire(configPath).resolve(extendsValue),
    );
  } catch {
    return null;
  }
}

export function normalizeExtendsConfigPath(
  configPath: string,
  extendsValue: string,
): string | null {
  const trimmedValue = extendsValue.trim();
  if (trimmedValue.length === 0) {
    return null;
  }

  return isPathLikeExtends(trimmedValue)
    ? normalizeLocalExtendsPath(configPath, trimmedValue)
    : resolvePackageExtendsPath(configPath, trimmedValue);
}

function getExtendsValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function canReadTargetConfig(configPath: string, seen: Set<string>): boolean {
  return !seen.has(configPath) && existsSync(configPath);
}

function readOwnCompilerTarget(
  configObject: Record<string, unknown>,
): string | null {
  if (!isPlainRecord(configObject.compilerOptions)) {
    return null;
  }

  const target = configObject.compilerOptions.target;
  return isNonEmptyString(target) ? target.trim() : null;
}

function preferTarget(
  nextTarget: string | null,
  currentTarget: string | null,
): string | null {
  return nextTarget === null ? currentTarget : nextTarget;
}

function readInheritedCompilerTarget(options: {
  config: ResolvedLiminaConfig;
  configObject: Record<string, unknown>;
  configPath: string;
  seen: Set<string>;
}): string | null {
  let target: string | null = null;

  for (const entry of getExtendsValues(options.configObject.extends)) {
    const extendedPath = normalizeExtendsConfigPath(options.configPath, entry);
    if (extendedPath === null) {
      continue;
    }

    target = preferTarget(
      readExplicitSourceCompilerTarget({
        config: options.config,
        configPath: extendedPath,
        seenConfigPaths: options.seen,
      }),
      target,
    );
  }

  return target;
}

export function readExplicitSourceCompilerTarget(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  seenConfigPaths?: Set<string>;
}): string | null {
  const seen = options.seenConfigPaths ?? new Set<string>();
  const configPath = normalizeAbsolutePath(options.configPath);
  if (!canReadTargetConfig(configPath, seen)) {
    return null;
  }

  seen.add(configPath);
  const configObject = readJsonConfig(options.config, configPath);
  const inheritedTarget = readInheritedCompilerTarget({
    config: options.config,
    configObject,
    configPath,
    seen,
  });
  return preferTarget(readOwnCompilerTarget(configObject), inheritedTarget);
}
