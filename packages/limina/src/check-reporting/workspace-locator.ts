import { resolveGovernanceManifest } from '#utils/governance-manifest';
import path from 'pathe';
import { resolveQueryConfigAnchor } from '../config/loader-paths';

export interface CheckIssueWorkspaceLocation {
  configPath: string;
  rootDir: string;
}

/** Locate persisted state without importing config or resolving membership. */
export function locateCheckIssueWorkspace(
  options: { configPath?: string; cwd?: string } = {},
): CheckIssueWorkspaceLocation {
  const { configPath } = resolveQueryConfigAnchor(options);
  const { rootDir } = resolveGovernanceManifest(path.dirname(configPath));
  return { configPath, rootDir };
}
