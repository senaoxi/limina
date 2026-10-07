import { normalizeAbsolutePath } from '#utils/path';
import {
  parsePackageManager,
  type SupportedPackageManager,
} from '#utils/workspace-root';
import path from 'pathe';
import { pnpmBranchLocks } from './branch-locks';
import type { InputDependency } from './contracts';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';
import {
  npmSetting,
  readInstallationText,
  readInstallationYaml,
  requireInstallationManifest,
} from './installation-files';

export const lockNames: Record<SupportedPackageManager, string[]> = {
  pnpm: ['pnpm-lock.yaml'],
  npm: ['npm-shrinkwrap.json', 'package-lock.json'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
};
interface BindingOptions {
  root: string;
  installationScope?: string;
  configPath: string;
  inputs: AnalysisInputs;
  dependencies: InputDependency[];
}
function inferManager(options: BindingOptions): SupportedPackageManager {
  const present = Object.entries(lockNames).filter(([, files]) =>
    files
      .map((file) => {
        const full = path.join(options.root, file);
        options.dependencies.push(
          options.inputs.observe(full, 'file'),
          options.inputs.observe(full, 'binding'),
        );
        return inputStat(full)?.isFile();
      })
      .some(Boolean),
  );
  if (present.length !== 1)
    throw new Error(`Ambiguous installation manager: ${options.root}`);
  return present[0]![0] as SupportedPackageManager;
}
function resolveManager(
  options: BindingOptions,
  manifest: Record<string, unknown>,
): SupportedPackageManager {
  return manifest.packageManager === undefined
    ? inferManager(options)
    : parsePackageManager(manifest.packageManager);
}
function isWithinRoot(file: string, root: string): boolean {
  return [file === root, file.startsWith(`${root}/`)].some(Boolean);
}
function hasManifest(options: BindingOptions, directory: string): boolean {
  const file = path.join(directory, 'package.json');
  options.dependencies.push(
    options.inputs.observe(file, 'file'),
    options.inputs.observe(file, 'binding'),
  );
  return inputStat(file)?.isFile() ?? false;
}
function resolutionRoot(options: BindingOptions): string {
  if (options.installationScope !== undefined) return options.installationScope;
  const cursor = path.dirname(options.configPath);
  return isWithinRoot(cursor, options.root)
    ? ancestorResolutionRoot(options, cursor)
    : options.root;
}
function ancestorResolutionRoot(
  options: BindingOptions,
  initial: string,
): string {
  let cursor = initial;
  while (cursor !== options.root) {
    if (hasManifest(options, cursor)) return cursor;
    cursor = path.dirname(cursor);
  }
  hasManifest(options, options.root);
  return options.root;
}

function pnpmLockRoot(
  options: BindingOptions,
  settings: Record<string, unknown>,
  npmrc: string,
): string {
  const isIndependent = [
    settings.sharedWorkspaceLockfile === false,
    npmSetting(npmrc, 'shared-workspace-lockfile') === 'false',
  ].some(Boolean);
  const root = isIndependent ? resolutionRoot(options) : options.root;
  const directory = lockDirectory(npmrc, settings);
  return customLockRoot(root, directory);
}
function lockDirectory(
  npmrc: string,
  settings: Record<string, unknown>,
): unknown {
  return npmSetting(npmrc, 'lockfile-dir') ?? settings.lockfileDir;
}
function customLockRoot(root: string, directory: unknown): string {
  if (typeof directory !== 'string') return root;
  if (directory.includes('${'))
    throw new Error(`Unresolved lock binding: ${root}`);
  return normalizeAbsolutePath(path.resolve(root, directory));
}
function assertInstalledManager(
  manager: SupportedPackageManager,
  installed: Record<string, unknown>,
): void {
  if (installed.packageManager === undefined) return;
  if (parsePackageManager(installed.packageManager) !== manager)
    throw new Error('Installed and selected package managers differ.');
}
function isClassicYarn(identity: unknown): boolean {
  return typeof identity === 'string' && /^yarn@1\./.test(identity);
}
function assertYarnHost(options: BindingOptions, identity: unknown): void {
  const yarn = readInstallationYaml(
    path.join(options.root, '.yarnrc.yml'),
    options.inputs,
    options.dependencies,
  );
  const isClassic = isClassicYarn(identity);
  if (isClassic) return;
  if (yarn.nodeLinker !== 'node-modules')
    throw new Error(`Unproven Yarn host: ${options.root}`);
}
function managerIdentity(
  manager: SupportedPackageManager,
  installed: Record<string, unknown>,
  manifest: Record<string, unknown>,
): string {
  return String(
    installed.packageManager ??
      manifest.packageManager ??
      `${manager}:physical-lock`,
  );
}
function selectedLockRoot(
  manager: SupportedPackageManager,
  options: BindingOptions,
  settings: { workspace: Record<string, unknown>; npmrc: string },
): string {
  return manager === 'pnpm'
    ? pnpmLockRoot(options, settings.workspace, settings.npmrc)
    : options.root;
}
function projectBindingSettings(
  options: BindingOptions,
  rootSettings: string,
): void {
  const project = resolutionRoot(options);
  if (project === options.root) return;
  const settings = bindingText(options, project);
  for (const name of [
    'shared-workspace-lockfile',
    'git-branch-lockfile',
    'lockfile-dir',
  ])
    assertCompatibleSetting(name, settings, rootSettings);
}
function assertCompatibleSetting(
  name: string,
  project: string,
  root: string,
): void {
  const selected = npmSetting(project, name);
  if (selected !== undefined && selected !== npmSetting(root, name))
    throw new Error(`Unproven project-local installation setting: ${name}`);
}
function bindingText(options: BindingOptions, root: string): string {
  return (
    readInstallationText(
      path.join(root, '.npmrc'),
      options.inputs,
      options.dependencies,
    ) ?? ''
  );
}
function lockCandidates(
  manager: SupportedPackageManager,
  options: BindingOptions,
  settings: { workspace: Record<string, unknown>; npmrc: string },
): string[] {
  return manager === 'pnpm'
    ? pnpmBranchLocks({
        root: options.root,
        settings: settings.workspace,
        npmrc: settings.npmrc,
        inputs: options.inputs,
        dependencies: options.dependencies,
      })
    : lockNames[manager];
}
export function installationBindings(options: BindingOptions): {
  manager: SupportedPackageManager;
  managerIdentity: string;
  resolutionRoot: string;
  lockRoot: string;
  lockCandidates: string[];
} {
  const manifest = requireInstallationManifest(
    path.join(options.root, 'package.json'),
    options.inputs,
    options.dependencies,
  );
  const manager = resolveManager(options, manifest);
  const installed = readInstallationYaml(
    path.join(options.root, 'node_modules/.modules.yaml'),
    options.inputs,
    options.dependencies,
  );
  assertInstalledManager(manager, installed);
  const workspace = readInstallationYaml(
    path.join(options.root, 'pnpm-workspace.yaml'),
    options.inputs,
    options.dependencies,
  );
  const npmrc = bindingText(options, options.root);
  projectBindingSettings(options, npmrc);
  if (manager === 'yarn') assertYarnHost(options, manifest.packageManager);
  return {
    manager,
    managerIdentity: managerIdentity(manager, installed, manifest),
    resolutionRoot: resolutionRoot(options),
    lockRoot: selectedLockRoot(manager, options, { workspace, npmrc }),
    lockCandidates: lockCandidates(manager, options, { workspace, npmrc }),
  };
}
