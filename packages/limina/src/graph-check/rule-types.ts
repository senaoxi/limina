export interface GraphRuleRef {
  path: string;
  reason: string;
}

export type GraphRuleRefDeny = GraphRuleRef;
export type GraphRuleRefAllow = GraphRuleRef;

export interface GraphRuleDepDeny {
  kind: 'node-builtin' | 'package' | 'package-import';
  matchAllNodeBuiltins: boolean;
  name: string;
  normalizedName: string;
  reason: string;
}

export interface NormalizedGraphRules {
  allowRefsByLabel: Map<string, Map<string, GraphRuleRefAllow>>;
  depsByLabel: Map<string, GraphRuleDepDeny[]>;
  refsByLabel: Map<string, Map<string, GraphRuleRefDeny>>;
}

export interface GraphRuleKindSelection {
  deps?: boolean;
  refs?: boolean;
}

export type LabelSelection = readonly string[] | string | null;
