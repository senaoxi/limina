import type { CheckerProjectParseContext } from '#checkers';
import type { PackageOwner } from '#core/workspace/actions';

export interface GovernanceUnit {
  configPaths: string[];
  owner: PackageOwner;
}

export type GovernanceUnitsByFile = Map<string, Map<string, GovernanceUnit>>;

export type AmbientConsumersByFile = Map<string, Map<string, GovernanceUnit>>;

export interface TsconfigGovernanceCollection {
  ambientConsumersByFile: AmbientConsumersByFile;
  context: CheckerProjectParseContext;
  governanceUnitsByFile: GovernanceUnitsByFile;
  projectFileSetsByConfigPath: Map<string, Set<string>>;
}
