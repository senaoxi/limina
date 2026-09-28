import type { ResolvedLiminaConfig } from '#config/runner';
import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import {
  collectActivatedPackageFileCandidates,
  type WorkspaceRegionFilePathIndex,
} from '../core/workspace/file-candidates';
import type { ValidatedWorkspaceContext } from '../core/workspace/validated-context';
import {
  collectAmbientRuleConfiguration,
  collectAmbientRuleMatches,
} from './ambient-declaration-rules';
import {
  AmbientDeclarationIndexImpl,
  type AmbientDeclarationIndexResult,
  type AmbientDeclarationPolicy,
  type AmbientDeclarationRule,
} from './ambient-declaration-types';
import { collectAmbientPolicies } from './ambient-declaration-validation';

export type {
  AmbientDeclarationIndex,
  AmbientDeclarationIndexResult,
  AmbientDeclarationPolicy,
} from './ambient-declaration-types';

type SourceConfig = NonNullable<ResolvedLiminaConfig['source']>;

function getAmbientRulesFromSource(
  source: SourceConfig,
): readonly AmbientDeclarationRule[] {
  const declarations = source.declarations;

  if (declarations === undefined) {
    return [];
  }

  return declarations.ambient === undefined ? [] : declarations.ambient;
}

function getAmbientRules(
  config: ResolvedLiminaConfig,
): readonly AmbientDeclarationRule[] {
  return config.source === undefined
    ? []
    : getAmbientRulesFromSource(config.source);
}

function createPolicyEntries(
  policies: readonly AmbientDeclarationPolicy[],
): [string, AmbientDeclarationPolicy][] {
  return policies.map((policy) => [policy.filePath, policy]);
}

export async function createAmbientDeclarationIndex(options: {
  config: ResolvedLiminaConfig;
  generatedGraph: GeneratedTsconfigGraphResult;
  workspaceContext: ValidatedWorkspaceContext;
  workspacePathIndex?: WorkspaceRegionFilePathIndex;
}): Promise<AmbientDeclarationIndexResult> {
  const rules = getAmbientRules(options.config);
  const candidates = await collectActivatedPackageFileCandidates(
    options.workspaceContext,
    options.workspacePathIndex,
  );
  const ruleMatches = collectAmbientRuleMatches({
    candidates,
    config: options.config,
    rules,
  });
  const configuration = collectAmbientRuleConfiguration({
    config: options.config,
    ruleMatches,
  });
  const policyResult = await collectAmbientPolicies({
    config: options.config,
    generatedGraph: options.generatedGraph,
    overlappingRules: configuration.overlappingRules,
    ruleMatches,
    workspaceContext: options.workspaceContext,
  });

  return {
    index: new AmbientDeclarationIndexImpl(
      createPolicyEntries(policyResult.policies),
    ),
    issues: [...configuration.issues, ...policyResult.issues],
  };
}
