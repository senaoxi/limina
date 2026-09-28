import {
  collectWorkspacePackages,
  getManifestPackageName,
  type WorkspacePackage,
} from '#core/workspace/actions';
import {
  classifyGovernanceRoot,
  findNearestPackageManifest,
  readGovernanceManifest,
  type ResolvedGovernanceRoot,
  resolveGovernancePackageManager,
  type SupportedPackageManager,
} from '#utils/workspace-root';
import { confirmAction } from './prompts';
import { createInitConfig } from './shared';
import type { InitPromptOptions } from './types';

export interface InitRootLocation {
  rootDir: string;
  governanceRoot: ResolvedGovernanceRoot | null;
  packageManager?: SupportedPackageManager;
}

function optionalInitManager(
  root: ResolvedGovernanceRoot,
): SupportedPackageManager | undefined {
  // Manager metadata only selects a suggestion. Init has no manager capability requirement.
  try {
    return resolveGovernancePackageManager(root);
  } catch {
    return undefined;
  }
}

export async function resolveInitWorkspace(options: {
  cwd: string;
  prompt: InitPromptOptions;
}): Promise<InitRootLocation> {
  const root = resolveInitLocation(options.cwd);
  if (
    !(await confirmAction({
      message: initRootMessage(root),
      prompt: options.prompt,
    }))
  ) {
    throw new Error('limina init canceled.');
  }
  return root;
}

function resolveInitLocation(cwd: string): InitRootLocation {
  const manifestPath = findNearestPackageManifest(cwd);
  if (manifestPath === null) return { rootDir: cwd, governanceRoot: null };
  const governanceRoot = classifyGovernanceRoot(
    readGovernanceManifest(manifestPath),
  );
  return {
    rootDir: governanceRoot.rootDir,
    governanceRoot,
    packageManager: optionalInitManager(governanceRoot),
  };
}

function initRootMessage(root: InitRootLocation): string {
  if (root.governanceRoot === null)
    return `Create package.json and Limina config at ${root.rootDir}?`;
  return `Use ${root.governanceRoot.kind} ${initRootName(root.governanceRoot)}at ${root.rootDir}?`;
}

function initRootName(root: ResolvedGovernanceRoot): string {
  const name = getManifestPackageName(root.manifest);
  return name === null ? '' : `"${name}" `;
}

export async function collectInitWorkspacePackages(
  root: InitRootLocation,
): Promise<WorkspacePackage[]> {
  if (root.governanceRoot === null) return [];
  const packages = await collectWorkspacePackages(
    createInitConfig(root.governanceRoot),
  );
  return packages.filter(
    (workspacePackage) => workspacePackage.directory !== root.rootDir,
  );
}

export const initCommands: Record<SupportedPackageManager, { build: string }> =
  {
    pnpm: { build: 'pnpm limina:build' },
    npm: { build: 'npm run limina:build' },
    yarn: { build: 'yarn limina:build' },
    bun: { build: 'bun run limina:build' },
  };
