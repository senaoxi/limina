import type { RuntimeEnvironment } from '#config/runner';
import { init, parse } from 'es-module-lexer';
import { readdir, readFile } from 'node:fs/promises';
import path from 'pathe';
import { collectSelfSpecifierMatchers } from './manifest';
import { validatePublishedSpecifier } from './published-boundary-specifier';
import type {
  PublishedPackageBoundaryTarget,
  PublishedPackageBoundaryViolation,
} from './runner-types';
import { readDistPackageJson } from './tarball';

function normalizePublishedModulePath(relativeFilePath: string): string {
  return relativeFilePath.replaceAll('\\', '/');
}

function getConfiguredEnvironment(
  target: PublishedPackageBoundaryTarget,
  relativeFilePath: string,
): RuntimeEnvironment | null {
  if (typeof target.environment === 'function') {
    return target.environment(relativeFilePath);
  }
  if (target.environment !== undefined) return target.environment;
  return null;
}

function getDefaultEnvironment(relativeFilePath: string): RuntimeEnvironment {
  const normalizedPath = normalizePublishedModulePath(relativeFilePath);
  const nodePrefixes = ['node/', 'plugin/'];
  return nodePrefixes.some((prefix) => normalizedPath.startsWith(prefix))
    ? 'node'
    : 'browser';
}

function classifyRuntimeEnvironment(
  target: PublishedPackageBoundaryTarget,
  relativeFilePath: string,
): RuntimeEnvironment {
  const configured = getConfiguredEnvironment(target, relativeFilePath);
  if (configured !== null) return configured;
  return getDefaultEnvironment(relativeFilePath);
}

async function collectPublishedEntryFiles(options: {
  absolutePath: string;
  isDirectory: boolean;
  name: string;
}): Promise<string[]> {
  if (options.isDirectory) {
    return collectPublishedModuleFiles(options.absolutePath);
  }
  if (/\.[cm]?js$/u.test(options.name)) return [options.absolutePath];
  return [];
}

async function collectPublishedModuleFiles(
  directoryPath: string,
): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) =>
      collectPublishedEntryFiles({
        absolutePath: path.join(directoryPath, entry.name),
        isDirectory: entry.isDirectory(),
        name: entry.name,
      }),
    ),
  );
  return files.flat();
}

function getDependencyNames(
  dependencies: Record<string, string> | undefined,
): string[] {
  return dependencies === undefined ? [] : Object.keys(dependencies);
}

function collectAllowedExternalPackages(options: {
  ignoredExternalPackages: readonly string[];
  manifest: Awaited<ReturnType<typeof readDistPackageJson>>;
}): Set<string> {
  return new Set([
    ...getDependencyNames(options.manifest.dependencies),
    ...getDependencyNames(options.manifest.peerDependencies),
    ...getDependencyNames(options.manifest.optionalDependencies),
    ...options.ignoredExternalPackages,
  ]);
}

interface BoundaryAuditContext {
  allowedExternalPackages: Set<string>;
  importsField: Awaited<ReturnType<typeof readDistPackageJson>>['imports'];
  packageName: string;
  selfSpecifiers: ReturnType<typeof collectSelfSpecifierMatchers>;
  target: PublishedPackageBoundaryTarget;
}

function createImportViolation(options: {
  context: BoundaryAuditContext;
  environment: RuntimeEnvironment;
  relativeFilePath: string;
  specifier: string | undefined;
}): PublishedPackageBoundaryViolation | null {
  if (options.specifier === undefined) return null;
  const message = validatePublishedSpecifier({
    allowedExternalPackages: options.context.allowedExternalPackages,
    environment: options.environment,
    importsField: options.context.importsField,
    outDir: options.context.target.outDir,
    packageName: options.context.packageName,
    selfSpecifiers: options.context.selfSpecifiers,
    specifier: options.specifier,
  });
  if (message === null) return null;
  return {
    environment: options.environment,
    filePath: options.relativeFilePath,
    message,
    specifier: options.specifier,
  };
}

async function collectFileViolations(options: {
  context: BoundaryAuditContext;
  filePath: string;
}): Promise<PublishedPackageBoundaryViolation[]> {
  const relativeFilePath = path.relative(
    options.context.target.outDir,
    options.filePath,
  );
  const environment = classifyRuntimeEnvironment(
    options.context.target,
    relativeFilePath,
  );
  const source = await readFile(options.filePath, 'utf8');
  const [importSpecifiers] = parse(source);
  return importSpecifiers.flatMap((importSpecifier) => {
    const violation = createImportViolation({
      context: options.context,
      environment,
      relativeFilePath,
      specifier: importSpecifier.n,
    });
    return violation === null ? [] : [violation];
  });
}

function sortViolations(
  violations: PublishedPackageBoundaryViolation[],
): PublishedPackageBoundaryViolation[] {
  return violations.toSorted((left, right) => {
    if (left.filePath === right.filePath) {
      return left.specifier.localeCompare(right.specifier);
    }
    return left.filePath.localeCompare(right.filePath);
  });
}

export async function auditPublishedPackageBoundaries(
  target: PublishedPackageBoundaryTarget,
): Promise<PublishedPackageBoundaryViolation[]> {
  const manifest = await readDistPackageJson({
    packageJsonPath: path.join(target.outDir, 'package.json'),
  });
  const context: BoundaryAuditContext = {
    allowedExternalPackages: collectAllowedExternalPackages({
      ignoredExternalPackages: target.ignoredExternalPackages ?? [],
      manifest,
    }),
    importsField: manifest.imports,
    packageName: manifest.name,
    selfSpecifiers: collectSelfSpecifierMatchers(
      manifest.name,
      manifest.exports,
    ),
    target,
  };
  const publishedFiles = await collectPublishedModuleFiles(target.outDir);
  await init;
  const violationGroups = await Promise.all(
    publishedFiles.map((filePath) =>
      collectFileViolations({ context, filePath }),
    ),
  );
  return sortViolations(violationGroups.flat());
}
