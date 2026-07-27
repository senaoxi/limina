import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import type { CheckCounter } from '../check-reporting/stats';
import type { WorkspaceLookupIndex } from '../core/workspace/lookup';
import type { AmbientDeclarationIndex } from './ambient-declarations';
import { addAmbientSharingFindings } from './ambient-sharing-findings';
import type { SourceFinding } from './findings';
import { addGovernanceOverlapFindings } from './governance-overlap-findings';
import { collectTsconfigGovernance } from './tsconfig-governance-collection';

export async function addTsconfigGovernanceProblems(options: {
  ambientDeclarations: AmbientDeclarationIndex;
  checks: CheckCounter;
  config: ResolvedLiminaConfig;
  configPaths: string[];
  findings: SourceFinding[];
  generatedGraph: GeneratedTsconfigGraphResult;
  workspaceLookup: WorkspaceLookupIndex;
}): Promise<void> {
  const collection = collectTsconfigGovernance(options);

  addAmbientSharingFindings({
    ambientConsumersByFile: collection.ambientConsumersByFile,
    ambientDeclarations: options.ambientDeclarations,
    checks: options.checks,
    config: options.config,
    findings: options.findings,
  });
  addGovernanceOverlapFindings({
    checks: options.checks,
    config: options.config,
    context: collection.context,
    findings: options.findings,
    governanceUnitsByFile: collection.governanceUnitsByFile,
    projectFileSetsByConfigPath: collection.projectFileSetsByConfigPath,
  });
}
