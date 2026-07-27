import { CHECKER_DETECTOR_COVERAGE } from './detectors/checker';
import { GRAPH_DETECTOR_COVERAGE } from './detectors/graph';
import { PACKAGE_DETECTOR_COVERAGE } from './detectors/package';
import { PROOF_DETECTOR_COVERAGE } from './detectors/proof';
import { RELEASE_DETECTOR_COVERAGE } from './detectors/release';
import { SOURCE_DETECTOR_COVERAGE } from './detectors/source';
import {
  completeDetectorCoverageRegistry,
  type DetectorCoverageRegistry,
} from './detectors/types';
import { WORKSPACE_DETECTOR_COVERAGE } from './detectors/workspace';

export { LIMINA_DETECTOR_SCENARIO_COVERAGE } from './detectors/scenario-coverage';
export type {
  DetectorCoverageEntry,
  DetectorCoverageRegistry,
  DetectorScenarioCoverageEntry,
  DetectorScenarioCoverageRegistry,
  PartialDetectorCoverageRegistry,
} from './detectors/types';

export const LIMINA_CHECK_ISSUE_DETECTOR_COVERAGE: DetectorCoverageRegistry =
  completeDetectorCoverageRegistry([
    CHECKER_DETECTOR_COVERAGE,
    GRAPH_DETECTOR_COVERAGE,
    PACKAGE_DETECTOR_COVERAGE,
    PROOF_DETECTOR_COVERAGE,
    RELEASE_DETECTOR_COVERAGE,
    SOURCE_DETECTOR_COVERAGE,
    WORKSPACE_DETECTOR_COVERAGE,
  ]);
