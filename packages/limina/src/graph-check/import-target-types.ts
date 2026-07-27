import type { ImportRecord, ProjectInfo } from '#core/import-graph/context';
import type {
  ExpectedReferenceCollectionContext,
  GraphImportResolution,
} from './reference-types';

export interface ImportTargetOptions {
  context: ExpectedReferenceCollectionContext;
  importRecord: ImportRecord;
  project: ProjectInfo;
  resolution: GraphImportResolution;
}
