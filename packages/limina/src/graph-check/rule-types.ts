export interface GraphRuleReference {
  path: string;
  reason: string;
}

export type GraphRuleReferenceDeny = GraphRuleReference;
export type GraphRuleReferenceAllow = GraphRuleReference;

export interface GraphRuleDependencyDeny {
  kind: 'node-builtin' | 'package' | 'package-import';
  matchAllNodeBuiltins: boolean;
  name: string;
  normalizedName: string;
  reason: string;
}

export interface NormalizedGraphRules {
  allowRefsByLabel: Map<string, Map<string, GraphRuleReferenceAllow>>;
  depsByLabel: Map<string, GraphRuleDependencyDeny[]>;
  refsByLabel: Map<string, Map<string, GraphRuleReferenceDeny>>;
}

export interface GraphRuleKindSelection {
  deps?: boolean;
  refs?: boolean;
}

export type LabelSelection = readonly string[] | string | null;
