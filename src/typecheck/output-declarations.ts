export { copyOutputDeclarationInputs } from './output/copy';
export {
  createOutputDeclarationCopyPlan,
  isDeclarationInputFile,
  mergeOutputDeclarationCopyPlans,
} from './output/plan';
export {
  formatOutputDeclarationCopyErrors,
  formatOutputDeclarationCopyWarnings,
} from './output/report';
export { OutputDeclarationCopyError } from './output/types';
export type {
  OutputDeclarationCopyOptions,
  OutputDeclarationCopyPlan,
  OutputDeclarationCopyPlanEntry,
  OutputDeclarationCopyProblem,
  OutputDeclarationCopyProblemReason,
} from './output/types';
