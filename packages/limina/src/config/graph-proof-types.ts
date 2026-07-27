export interface GraphRuleRefDenyEntry {
  path: string;
  reason: string;
}

export interface GraphRuleRefAllowEntry {
  path: string;
  reason: string;
}

export interface GraphRuleDepDenyEntry {
  name: string;
  reason: string;
}

export interface GraphRuleDenyConfig {
  deps?: GraphRuleDepDenyEntry[];
  refs?: GraphRuleRefDenyEntry[];
}

export interface GraphRuleAllowConfig {
  refs?: GraphRuleRefAllowEntry[];
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
