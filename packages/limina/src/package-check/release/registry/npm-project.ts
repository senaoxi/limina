import { nonPruningGlobGroup, npmPackageGlobs } from '#core/workspace/actions';
import { isPlainRecord } from '#utils/values';
import { existsSync } from 'node:fs';
import path from 'pathe';
import { globSync } from 'tinyglobby';
import { RegistryAuthorityError } from './authority';
import { readOptionalRegistryFile } from './npm-config-values';

function readProjectManifest(
  directory: string,
): Record<string, unknown> | undefined {
  const filePath = path.join(directory, 'package.json');
  const contents = readOptionalRegistryFile(filePath);
  return contents === undefined
    ? undefined
    : parseProjectManifest(contents, filePath);
}

function parseProjectManifest(
  contents: string,
  filePath: string,
): Record<string, unknown> {
  try {
    const manifest: unknown = JSON.parse(contents);
    if (isPlainRecord(manifest)) return manifest;
  } catch {
    /*
    Report without including package contents.
    */
  }
  throw new RegistryAuthorityError(filePath, 'invalid npm project manifest');
}

function workspacePatterns(manifest: Record<string, unknown>): string[] {
  const workspaces = manifest.workspaces;
  const patterns = isPlainRecord(workspaces) ? workspaces.packages : workspaces;
  return Array.isArray(patterns)
    ? patterns.filter((value): value is string => typeof value === 'string')
    : [];
}

function isWorkspaceMember(
  root: string,
  localPrefix: string,
  manifest: Record<string, unknown>,
): boolean {
  const patterns = workspacePatterns(manifest);
  if (patterns.length === 0) return false;
  const group = nonPruningGlobGroup(npmPackageGlobs(patterns), root);
  const members = globSync([...group.packageGlobs], {
    cwd: root,
    absolute: true,
    onlyDirectories: true,
    expandDirectories: false,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });
  return members
    .filter((member) => group.acceptsDirectory?.(path.relative(root, member)))
    .some((member) => path.resolve(member) === localPrefix);
}

function isProjectDirectory(directory: string): boolean {
  return ['package.json', 'node_modules'].some((name) =>
    existsSync(path.join(directory, name)),
  );
}

function findLocalPrefix(cwd: string): string {
  let directory = cwd;
  while (path.dirname(directory) !== directory) {
    if (isProjectDirectory(directory)) return directory;
    directory = path.dirname(directory);
  }
  return cwd;
}

function* ancestorDirectories(localPrefix: string): Generator<string> {
  let directory = path.dirname(localPrefix);
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === 'node_modules') return;
    yield directory;
    directory = path.dirname(directory);
  }
}

function isMatchesWorkspace(directory: string, localPrefix: string): boolean {
  const manifest = readProjectManifest(directory);
  return (
    manifest !== undefined &&
    isWorkspaceMember(directory, localPrefix, manifest)
  );
}

export function resolveNpmProjectDirectory(cwd: string): string {
  const localPrefix = findLocalPrefix(cwd);
  for (const directory of ancestorDirectories(localPrefix)) {
    if (isMatchesWorkspace(directory, localPrefix)) return directory;
  }
  return localPrefix;
}
