import { parsePackageManager } from '#utils/workspace-root';
import path from 'pathe';
import type { InputDependency } from './contracts';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';
import { lockNames } from './installation-bindings';
import {
  readInstallationText,
  readInstallationYaml,
} from './installation-files';

interface OwnerOptions {
  root: string;
  inputs: AnalysisInputs;
  dependencies: InputDependency[];
}
function hasFile(options: OwnerOptions, root: string, name: string): boolean {
  const file = path.join(root, name);
  const isPresent = inputStat(file)?.isFile() ?? false;
  const value = options.inputs.structural(file, 'file', isPresent);
  options.dependencies.push(value, options.inputs.observe(file, 'binding'));
  return isPresent;
}
function hasOwnLock(options: OwnerOptions, root: string): boolean {
  return Object.values(lockNames)
    .flat()
    .map((name) => hasFile(options, root, name))
    .some(Boolean);
}
function installedManager(options: OwnerOptions, root: string): unknown {
  return readInstallationYaml(
    path.join(root, 'node_modules/.modules.yaml'),
    options.inputs,
    options.dependencies,
  ).packageManager;
}
function hasWorkspace(options: OwnerOptions, root: string): boolean {
  return hasFile(options, root, 'pnpm-workspace.yaml');
}
function hasForeignManager(options: OwnerOptions): boolean {
  const text = readInstallationText(
    path.join(options.root, 'package.json'),
    options.inputs,
    options.dependencies,
  );
  const manager: unknown =
    text === undefined ? undefined : JSON.parse(text).packageManager;
  return manager !== undefined && parsePackageManager(manager) !== 'pnpm';
}

// A member's node_modules container is not an independent installation. Only
// an observed pnpm workspace installation may claim it; lock coverage for the
// member itself is checked by installationBindings/validateInstallationLock.
export function installationOwner(options: OwnerOptions): string {
  return hasLocalBoundary(options) ? options.root : ancestorOwner(options);
}
function hasLocalBoundary(options: OwnerOptions): boolean {
  return [
    installedManager(options, options.root) !== undefined,
    hasOwnLock(options, options.root),
    hasWorkspace(options, options.root),
    hasForeignManager(options),
  ].some(Boolean);
}
function ancestors(root: string): string[] {
  const result: string[] = [];
  let cursor = root;
  while (path.dirname(cursor) !== cursor) {
    cursor = path.dirname(cursor);
    result.push(cursor);
  }
  return result;
}
function ancestorOwner(options: OwnerOptions): string {
  for (const root of ancestors(options.root)) {
    const owner = ancestorBoundary(options, root);
    if (owner !== undefined) return owner;
  }
  return options.root;
}
function ancestorBoundary(
  options: OwnerOptions,
  root: string,
): string | undefined {
  if (hasWorkspace(options, root)) return pnpmOwner(options, root);
  return hasOwnLock(options, root) ? options.root : undefined;
}
function pnpmOwner(options: OwnerOptions, root: string): string {
  const manager = installedManager(options, root);
  return manager !== undefined && parsePackageManager(manager) === 'pnpm'
    ? root
    : options.root;
}
