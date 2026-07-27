import type { ResolvedLiminaConfig } from '#config/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import type { GraphFinding } from './findings';
import { getRulesRecord } from './rule-findings';
import {
  addConfigFinding,
  addUnknownFields,
  getRuleRecord,
  getRuleSection,
  type NormalizationState,
} from './rule-normalization-shared';
import {
  normalizeAllowSection,
  normalizeDenySection,
} from './rule-section-normalization';
import type {
  GraphRuleKindSelection,
  NormalizedGraphRules,
} from './rule-types';

const graphRuleKeys = new Set(['allow', 'deny']);

function addEmptyLabelFinding(state: NormalizationState): void {
  const reason = 'graph.rules keys must be non-empty labels.';
  addConfigFinding({
    details: ['  field: graph.rules', `  reason: ${reason}`],
    reason,
    state,
  });
}

function normalizeRule(options: {
  rawLabel: string;
  rawRule: unknown;
  state: NormalizationState;
}): void {
  const label = options.rawLabel.trim();
  if (label.length === 0) {
    addEmptyLabelFinding(options.state);
    return;
  }
  const rule = getRuleRecord(options);
  if (rule === null) {
    return;
  }
  addUnknownFields({
    allowedKeys: graphRuleKeys,
    fieldPrefix: `graph.rules.${label}`,
    record: rule,
    reason: 'unknown graph rule field.',
    state: options.state,
  });
  const deny = getRuleSection({
    label,
    rawRule: rule,
    section: 'deny',
    state: options.state,
  });
  const allow = getRuleSection({
    label,
    rawRule: rule,
    section: 'allow',
    state: options.state,
  });
  normalizeDenySection(label, deny, options.state);
  normalizeAllowSection(label, allow, options.state);
}

function createNormalizationState(options: {
  config: ResolvedLiminaConfig;
  findings: GraphFinding[];
  include: GraphRuleKindSelection | undefined;
  projectPathAliases: Map<string, string> | undefined;
  projectPaths: string[];
}): NormalizationState {
  return {
    allowRefsByLabel: new Map(),
    config: options.config,
    depsByLabel: new Map(),
    findings: options.findings,
    include: options.include,
    projectPathAliases: options.projectPathAliases,
    projectPathSet: new Set(options.projectPaths),
    refsByLabel: new Map(),
  };
}

function toNormalizedRules(state: NormalizationState): NormalizedGraphRules {
  return {
    allowRefsByLabel: state.allowRefsByLabel,
    depsByLabel: state.depsByLabel,
    refsByLabel: state.refsByLabel,
  };
}

export function normalizeGraphRules(options: {
  config: ResolvedLiminaConfig;
  include?: GraphRuleKindSelection;
  packages: WorkspacePackage[];
  findings: GraphFinding[];
  projectPathAliases?: Map<string, string>;
  projectPaths: string[];
}): NormalizedGraphRules {
  const state = createNormalizationState({
    config: options.config,
    findings: options.findings,
    include: options.include,
    projectPathAliases: options.projectPathAliases,
    projectPaths: options.projectPaths,
  });
  const records = getRulesRecord(options.config, options.findings);
  for (const [rawLabel, rawRule] of Object.entries(records)) {
    normalizeRule({ rawLabel, rawRule, state });
  }
  return toNormalizedRules(state);
}
