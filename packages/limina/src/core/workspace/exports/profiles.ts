export {
  compareCodePoints,
  createTypeScriptResolutionSemanticsAdapter,
} from '../typescript-resolution-semantics';
export { compileWorkspaceExportResolutionGroups } from './groups';
export type {
  CompiledWorkspaceExportResolutionProfile,
  OxcResolverPlan,
  TypeScriptProfileFallbackReason,
  TypeScriptResolutionSemanticsAdapter,
  TypeScriptResolverPlan,
  TypeScriptWorkspaceExportProfileKey,
  WorkspaceExportResolutionGroups,
  WorkspaceExportSelfNameContext,
  WorkspaceExportSelfNameEntry,
} from './profile-types';
export { getWorkspaceExportSelfNameContext } from './self-name';
