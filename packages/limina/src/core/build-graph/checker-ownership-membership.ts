import type { AutoScopeProject } from './auto-checker-types';
import { FileOwnerLookup } from './file-owner-lookup';

export function createActualMembershipIndex(
  projects: ReadonlyMap<string, AutoScopeProject>,
): FileOwnerLookup {
  return new FileOwnerLookup(projects.values());
}
