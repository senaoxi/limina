import type { ResolvedLiminaConfig } from '#config/runner';
import { createDeniedProjectReferenceFinding } from './access-denied';
import type { GraphFinding } from './findings';
import { getDeniedReferenceRule } from './reference-rules';
import { normalizeGraphRules } from './rule-normalization';

export interface GovernedReference {
  checkerName: string;
  from: string;
  to: string;
  labels: string[];
}
export interface ReferenceGovernanceVerdict {
  state: 'clear' | 'denied' | 'unavailable';
  findings: GraphFinding[];
}

/**
Policy owner shared with graph:check. The caller supplies its actual reference scope.
*/
export function adjudicateReferences(options: {
  config: ResolvedLiminaConfig;
  references: readonly GovernedReference[];
  aliases: ReadonlyMap<string, string | readonly string[]>;
}): ReferenceGovernanceVerdict {
  const findings: GraphFinding[] = [];
  const labels = new Set(
    options.references.flatMap((reference) => reference.labels),
  );
  if (labels.size === 0) return { state: 'clear', findings };
  const rules = normalizeGraphRules({
    config: options.config,
    selectedLabels: labels,
    denyReferencesOnly: true,
    include: { deps: false, refs: true },
    packages: [],
    findings,
    projectPathAliases: options.aliases,
    projectPaths: options.aliases.values().toArray().flat(),
  });
  if (findings.length > 0) return { state: 'unavailable', findings };
  appendReferenceFindings(options.references, {
    config: options.config,
    findings,
    rules,
  });
  return { state: verdictState(findings), findings };
}

function appendReferenceFinding(
  context: {
    config: ResolvedLiminaConfig;
    findings: GraphFinding[];
    rules: ReturnType<typeof normalizeGraphRules>;
  },
  reference: GovernedReference,
): void {
  const rule = getDeniedReferenceRule(
    context.rules,
    reference.labels,
    reference.to,
  );
  if (rule === null) return;
  context.findings.push(
    createDeniedProjectReferenceFinding(
      {
        config: context.config,
        project: {
          configPath: reference.from,
          labels: reference.labels,
        },
        projectCheckerNamesByPath: new Map([
          [reference.from, reference.checkerName],
        ]),
      },
      reference.to,
      rule,
    ),
  );
}

function verdictState(
  findings: GraphFinding[],
): ReferenceGovernanceVerdict['state'] {
  return findings.length > 0 ? 'denied' : 'clear';
}

function appendReferenceFindings(
  references: readonly GovernedReference[],
  context: Parameters<typeof appendReferenceFinding>[0],
): void {
  for (const reference of references)
    appendReferenceFinding(context, reference);
}
