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
  denyReferencesOnly?: boolean;
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
  normalizeSelectedRule(options, label, rule);
}
function normalizeSelectedRule(
  options: Parameters<typeof normalizeRule>[0],
  label: string,
  rule: Record<string, unknown>,
): void {
  if (options.denyReferencesOnly === true) {
    normalizeDenySection(
      label,
      getRuleSection({
        label,
        rawRule: rule,
        section: 'deny',
        state: options.state,
      }),
      options.state,
    );
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
  projectPathAliases:
    | ReadonlyMap<string, string | readonly string[]>
    | undefined;
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
  selectedLabels?: ReadonlySet<string>;
  denyReferencesOnly?: boolean;
  config: ResolvedLiminaConfig;
  include?: GraphRuleKindSelection;
  packages: WorkspacePackage[];
  findings: GraphFinding[];
  projectPathAliases?: ReadonlyMap<string, string | readonly string[]>;
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
    if (isUnselectedLabel(options.selectedLabels, rawLabel)) continue;
    normalizeRule({
      rawLabel,
      rawRule,
      state,
      denyReferencesOnly: options.denyReferencesOnly,
    });
  }
  return toNormalizedRules(state);
}

function isUnselectedLabel(
  selected: ReadonlySet<string> | undefined,
  label: string,
): boolean {
  return selected !== undefined && !selected.has(label.trim());
}
