import type { CustomConditionConsistencyContext } from './condition-types';
import type {
  GraphConditionDomainMismatchFinding,
  GraphFinding,
} from './findings';

function getConditionMismatchIdentity(
  finding: GraphConditionDomainMismatchFinding,
): string {
  return finding.facts.kind === 'reference-tree'
    ? `${finding.code}\0reference-tree\0${finding.facts.rootProjectPath}\0${finding.facts.referencedProjectPath}`
    : `${finding.code}\0domain-entry\0${finding.facts.domainName}\0${finding.facts.entryProjectPath}`;
}

export function registerConditionFinding(
  context: CustomConditionConsistencyContext,
  finding: GraphConditionDomainMismatchFinding,
): string {
  const identity = getConditionMismatchIdentity(finding);
  if (!context.mismatchFindingsByIdentity.has(identity))
    context.mismatchFindingsByIdentity.set(identity, finding);
  return identity;
}

export function mergeConditionFindingIdentities(
  target: Set<string>,
  source: ReadonlySet<string>,
): void {
  for (const identity of source) target.add(identity);
}

export function addUniqueConditionFindings(
  findings: GraphFinding[],
  context: CustomConditionConsistencyContext,
  identities: ReadonlySet<string>,
): void {
  for (const identity of [...identities].sort()) {
    if (context.emittedFindingIdentities.has(identity)) continue;
    context.emittedFindingIdentities.add(identity);
    findings.push(context.mismatchFindingsByIdentity.get(identity)!);
  }
}
