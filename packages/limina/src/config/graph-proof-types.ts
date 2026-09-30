export interface GraphRuleReferenceDenyEntry {
  path: string;
  reason: string;
}

export interface GraphRuleReferenceAllowEntry {
  path: string;
  reason: string;
}

export interface GraphRuleDependencyDenyEntry {
  name: string;
  reason: string;
}

export interface GraphRuleDenyConfig {
  deps?: GraphRuleDependencyDenyEntry[];
  refs?: GraphRuleReferenceDenyEntry[];
}

export interface GraphRuleAllowConfig {
  refs?: GraphRuleReferenceAllowEntry[];
}

export interface GraphRule {
  allow?: GraphRuleAllowConfig;
  deny?: GraphRuleDenyConfig;
}

export interface GraphConditionDomain {
  customConditions: string[];
  entry: string;
  name: string;
}

export interface GraphConfig {
  conditionDomains?: GraphConditionDomain[];
  rules?: Record<string, GraphRule>;
}

export interface ProofAllowlistEntry {
  file: string;
  reason: string;
}

export interface ProofConfig {
  allowlist?: ProofAllowlistEntry[];
}
