import type { DependencyAnalysisResult } from 'limina/internal/core/build-graph/types';
import type { ReferencePathInfo } from 'limina/internal/core/tsconfig/action-types';
import type { JsonObject } from 'limina/internal/core/tsconfig/actions';
import {
  collectReferencePathInfosFromConfigObject,
  isOrdinarySourceTypecheckConfigPath,
  resolveReferencePath,
} from 'limina/internal/core/tsconfig/actions';
import type { LiminaArtifactNamespace } from 'limina/internal/domain/artifacts/namespace';
import { isPlainRecord } from 'limina/internal/utils/values';
import { createMembershipState, reachableSources } from './membership-state';
import type { MigrationPlanningState } from './planning-state';
import { collectAnalysis } from './relation-analysis';
import { relativeConfigPath } from './transform';

interface RelationPlan {
  state: MigrationPlanningState;
  analysis: DependencyAnalysisResult;
  retained: ReadonlySet<string>;
  inferred: ReadonlySet<string>;
  native: Set<string>;
  solutionMembers: ReadonlyMap<string, ReadonlySet<string>>;
}

function relationKey(from: string, to: string): string {
  return JSON.stringify([from, to]);
}

function firstClassification(rules: [boolean, string][]): string {
  return rules.find(([matches]) => matches)?.[1] ?? 'not a retained source';
}

function classifyUnretained(
  plan: RelationPlan,
  file: string,
  target: string,
): string {
  const rules: [boolean, string][] = [
    [file === target, 'self reference'],
    [plan.state.isolated.has(target), 'isolated target'],
    [
      !isOrdinarySourceTypecheckConfigPath(target, plan.state.config.rootDir),
      'not an ordinary source/solution config',
    ],
    [!plan.state.paths.includes(target), 'outside activated config topology'],
  ];
  return firstClassification(rules);
}

function existingReferenceTarget(
  reference: unknown,
  file: string,
): string | undefined {
  if (!isPlainRecord(reference)) return undefined;
  return typeof reference.path === 'string'
    ? resolveReferencePath(file, reference.path)
    : undefined;
}

function getMetadata(object: JsonObject): JsonObject {
  return isPlainRecord(object.liminaOptions) ? object.liminaOptions : {};
}

function implicitDeclarations(metadata: JsonObject): unknown[] {
  return Array.isArray(metadata.implicitRefs) ? metadata.implicitRefs : [];
}

function addImplicit(
  plan: RelationPlan,
  file: string,
  reference: ReferencePathInfo,
): void {
  const object = plan.state.objects.get(file)!;
  const metadata = getMetadata(object);
  const references = implicitDeclarations(metadata);
  const isExists = references.some(
    (reference_) =>
      existingReferenceTarget(reference_, file) === reference.resolvedPath,
  );
  if (!isExists)
    references.push({
      path: relativeConfigPath(file, reference.resolvedPath),
      reason: `Preserved native TypeScript reference ${reference.rawPath} during Limina migration.`,
    });
  plan.state.records.push({
    configPath: file,
    kind: isExists ? 'implicit-reused' : 'implicit-added',
    original: reference.rawPath,
    message: 'Preserved the explicit declaration and any existing user reason.',
  });
  object.liminaOptions = { ...metadata, implicitRefs: references };
}

function comparisonMessage(
  isComplete: boolean,
  isInferredValue: boolean,
): string {
  if (!isComplete)
    return 'comparison unavailable; preserving explicit declaration';
  return isInferredValue ? 'N ∩ G' : 'N - G';
}

function translateReference(
  plan: RelationPlan,
  file: string,
  reference: ReferencePathInfo,
): void {
  const members = plan.solutionMembers.get(reference.resolvedPath);
  if (members) {
    expandSolutionReference(plan, file, { reference, members });
    return;
  }
  if (!isRetainedReference(plan, file, reference)) {
    plan.state.records.push({
      configPath: file,
      kind: 'removed-native-reference',
      original: reference.rawPath,
      message: classifyUnretained(plan, file, reference.resolvedPath),
      details: { target: reference.resolvedPath },
    });
    return;
  }
  translateRetainedReference(plan, file, reference);
}

function isRetainedReference(
  plan: RelationPlan,
  file: string,
  reference: ReferencePathInfo,
): boolean {
  return (
    file !== reference.resolvedPath && plan.retained.has(reference.resolvedPath)
  );
}
function expandSolutionReference(
  plan: RelationPlan,
  file: string,
  declaration: { reference: ReferencePathInfo; members: ReadonlySet<string> },
): void {
  const { reference, members } = declaration;
  const sortedMembers = [...members].sort(
    (left, right) => Number(left > right) - Number(left < right),
  );
  plan.state.records.push({
    configPath: file,
    kind: 'native-solution-expanded',
    original: reference.rawPath,
    message:
      'Expanded the solution declaration to retained source members; checker mapping remains a core analysis concern.',
    details: { target: reference.resolvedPath, members: sortedMembers },
  });
  for (const member of sortedMembers)
    translateReference(plan, file, { ...reference, resolvedPath: member });
}

function translateRetainedReference(
  plan: RelationPlan,
  file: string,
  reference: ReferencePathInfo,
): void {
  const key = relationKey(file, reference.resolvedPath);
  plan.native.add(key);
  const isInferred = plan.inferred.has(key);
  plan.state.records.push({
    configPath: file,
    kind: 'native-comparison',
    original: reference.rawPath,
    message: comparisonMessage(plan.analysis.complete, isInferred),
  });
  if (isInferred && plan.analysis.complete) return;
  addImplicit(plan, file, reference);
}

function translateSource(plan: RelationPlan, file: string): void {
  const target = plan.state.targets.get(file)!;
  const references = collectReferencePathInfosFromConfigObject(
    plan.state.config.rootDir,
    file,
    target.configObject,
  );
  // Keep the full original declaration, including attributes the Limina
  // declaration language cannot carry, independently of successful inference.
  plan.state.records.push({
    configPath: file,
    kind: 'native-inventory',
    original: target.configObject.references,
    message:
      'Only source relationship paths are translated; native build attributes are not adopted.',
    details: { diagnostics: references.problems },
  });
  for (const reference of references.references)
    translateReference(plan, file, reference);
}

function recordInferredOnly(plan: RelationPlan): void {
  if (!plan.analysis.complete) return;
  const inferredOnly = plan.analysis.facts.filter(
    (fact) =>
      !plan.native.has(relationKey(fact.fromConfigPath, fact.toConfigPath)),
  );
  for (const fact of inferredOnly) {
    plan.state.records.push({
      configPath: fact.fromConfigPath,
      kind: 'inferred-only',
      message: 'G - N; no implicit reference added.',
      details: fact,
    });
  }
}

function analysisStatus(analysis: DependencyAnalysisResult): string {
  return analysis.complete
    ? 'complete'
    : 'incomplete; no definitive difference is inferred';
}

export async function translateRelations(
  state: MigrationPlanningState,
  artifactNamespace: LiminaArtifactNamespace,
): Promise<void> {
  const { analysis } = await collectAnalysis(state, artifactNamespace);
  state.records.push({
    configPath: state.config.configPath,
    kind: 'dependency-analysis',
    message: analysisStatus(analysis),
    details: analysis,
  });
  const membership = createMembershipState({
    rootDir: state.config.rootDir,
    targets: state.targets,
    objects: state.objects,
    records: [],
  });
  const plan: RelationPlan = {
    state,
    analysis,
    retained: membership.sources,
    solutionMembers: new Map(
      [...membership.solutions].map((file) => [
        file,
        reachableSources(membership, file),
      ]),
    ),
    inferred: new Set(
      analysis.facts.map((fact) =>
        relationKey(fact.fromConfigPath, fact.toConfigPath),
      ),
    ),
    native: new Set(),
  };
  for (const file of plan.retained) translateSource(plan, file);
  recordInferredOnly(plan);
}
