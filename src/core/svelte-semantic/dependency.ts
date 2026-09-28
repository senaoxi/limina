import type { FrameworkSemanticDependencyPreparation } from '../framework-semantic/contracts';

export type SvelteDependencyPreparation =
  FrameworkSemanticDependencyPreparation;

export { prepareSvelteSemanticDependencies } from './preparation';
export { mapGeneratedRange } from './source-mapping';
export {
  getSvelteScriptKind,
  isSvelteTypeScriptSource,
} from './source-records';
