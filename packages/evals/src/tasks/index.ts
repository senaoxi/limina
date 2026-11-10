import type { TaskDefinition } from '../controller/calibration.ts';
import { configRuleDefinition } from './C01.ts';
import { entryCoverageDefinition } from './C02.ts';
import { developmentDefinitions } from './development.ts';
import { manifestBoundaryDefinition } from './I03.ts';
import { checkerRoutingDefinition } from './K01.ts';
import { missingPeerDefinition } from './K03.ts';
import { packageExportsDefinition } from './P01.ts';
import { packedDependencyDefinition } from './P02.ts';
import { declarationConditionDefinition } from './R02.ts';
import { excludedClosureDefinition } from './R03.ts';
import { dependencyOwnerDefinition } from './S01.ts';
import { publicEntryDefinition } from './S02.ts';
import { configModuleDefinition } from './T01.ts';
import { staleManifestDefinition } from './T03.ts';
import { outputWorkflowDefinition } from './W02.ts';
import { migrationPreviewDefinition } from './W03.ts';

// Only implemented development tasks; suite admission still requires all 26.
export const availableDevelopmentTasks: TaskDefinition[] = [
  ...developmentDefinitions,
  manifestBoundaryDefinition,
  configRuleDefinition,
  entryCoverageDefinition,
  checkerRoutingDefinition,
  missingPeerDefinition,
  packageExportsDefinition,
  packedDependencyDefinition,
  declarationConditionDefinition,
  excludedClosureDefinition,
  dependencyOwnerDefinition,
  publicEntryDefinition,
  configModuleDefinition,
  staleManifestDefinition,
  outputWorkflowDefinition,
  migrationPreviewDefinition,
];
