import type { ProjectInfo } from '#core/import-graph/context';
import type { GraphConditionDomainMismatchFinding } from './findings';

export interface CustomConditionSubtreeSummary {
  consistentConditions: string[] | null;
  mismatchFindings: GraphConditionDomainMismatchFinding[];
  projectPaths: Set<string>;
}

export interface CustomConditionConsistencyContext {
  conditionsByProjectPath: Map<string, string[]>;
  projectCheckerNamesByPath: ReadonlyMap<string, string>;
  projectsByPath: Map<string, ProjectInfo>;
  subtreeByProjectPath: Map<string, CustomConditionSubtreeSummary>;
  visitingProjectPaths: Set<string>;
}

export interface ParsedConditionDomain {
  customConditions: string[];
  entry: string;
  name: string;
}
