import { z } from 'zod';
import { nativeAnalysisEvidenceSchema } from '../analysis-cache/native-evidence-schema';
import { nativeCoverageIndexSchema } from '../analysis-cache/native-proof-schema';
import { createProjectDependencyCaches } from '../project-dependencies/cache';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { finishAnalysisOutcome } from './analysis-outcome';
import {
  checker,
  stringMap,
  stringSet,
  text,
  texts,
} from './cached-data-schema';
import { jsonRecords, manifestSchema } from './cached-manifest-schema';
import { analysisOutcomeSchema } from './cached-outcome-schema';
import { authority, ownershipSchema } from './cached-ownership-schema';
import type {
  DependencyAnalysisResult,
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from './types';
export type CachedGraphData = Omit<
  GeneratedTsconfigGraphResult,
  'artifactPlan' | 'changed'
> & { dependencyAnalysis: DependencyAnalysisResult };
export type StoredGovernedSource = Omit<GovernedSourceUnit, 'context'> & {
  context: Omit<GovernedSourceUnit['context'], 'vueSemanticIdentity'> & {
    vueContextId?: string;
  };
};
export type StoredGraphData = Omit<CachedGraphData, 'governedSources'> & {
  governedSources: Map<string, Map<string, StoredGovernedSource>>;
};
const build = z.object({ kind: z.enum(['project', 'solution']), path: text });
const projection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('declaration-project'), dtsConfigPath: text }),
  z.object({ kind: z.literal('transparent-solution'), buildConfigPath: text }),
  z.object({
    kind: z.literal('wrapped-project'),
    buildConfigPath: text,
    dtsConfigPath: text,
  }),
]);
const governed = z.object({
  buildProjection: projection,
  configPath: text,
  context: z.object({
    checkerPresets: z.array(checker),
    extensions: texts,
    vueSemanticIdentity: z.undefined().optional(),
    vueContextId: text.optional(),
  }),
  declarationFileNames: texts,
  declarationReferences: stringSet,
  frameworkCapabilities: z.array(z.never()),
  ownedFileNames: texts,
  packageRootDir: text,
  primaryCheckerName: checker,
  semanticAuthority: authority,
  astroSemanticProject: z.undefined().optional(),
  svelteSemanticProject: z.undefined().optional(),
});
const edgeBase = {
  file: text,
  fromChecker: text,
  fromConfigPath: text,
  importedSpecifier: text,
  resolvedFilePath: text,
  toChecker: text,
  toConfigPath: text,
};
const edge = z.object({
  ...edgeBase,
  kind: z.literal('declaration-provider'),
  cacheReuse: z.enum(['non-reusable', 'reusable']),
});
const selection = z.object({
  name: checker,
  include: texts,
  exclude: texts,
  extensions: texts,
});
const copy = z.object({
  fileNames: texts,
  outDir: text,
  rootDir: text,
  sourceConfigPath: text,
});
const copies = z.array(copy);
const copyMap = stringMap(copies);
const relation = z.object({
  fromConfigPath: text,
  toConfigPath: text,
  file: text,
  specifier: text,
});
const candidateReference = z.object({ from: text, to: text });
const dependencyAnalysis = z.object({
  candidate: z
    .object({
      configPaths: texts,
      references: z.array(candidateReference),
      schedules: z.array(candidateReference),
    })
    .optional(),
  outcome: analysisOutcomeSchema,
  nativeEvidence: z.array(nativeAnalysisEvidenceSchema).optional(),
  complete: z.boolean(),
  diagnostics: texts,
  facts: z.array(relation),
});
const coveredOutput = z.object({ file: text, owner: text, outputConfig: text });
const effectiveTypeInput = z.object({ name: text, target: text.nullable() });
const effectiveTypeInputs = z.array(effectiveTypeInput);
const compilerOptions = z.record(text, z.json());
const outputProjection = z.object({
  scope: z.literal('existing-output-relations'),
  version: z.literal(1),
  sourceConfig: text,
  generatedConfig: text,
  sourceTarget: z.number().nullable(),
  outputTarget: z.number().nullable(),
  contextId: text.nullable(),
  vueContextId: text.optional(),
  optionsVersion: text,
  roots: texts,
  covered: z.array(coveredOutput),
});
const typeInputProjection = z.object({
  scope: z.literal('config-type-directives'),
  version: z.literal(2),
  compilerVersion: text,
  sourceConfig: text,
  generatedConfig: text,
  sourceOptions: compilerOptions,
  generatedOptions: compilerOptions,
  source: effectiveTypeInputs,
  generated: effectiveTypeInputs,
});
const graph = z.object({
  sourceConfigCoverage: nativeCoverageIndexSchema.optional(),
  outputProjections: z.array(outputProjection),
  typeInputProjections: z.array(typeInputProjection),
  dependencyAnalysis,
  checkers: z.array(selection),
  manifestPath: text,
  checkerEntries: stringMap(text),
  configToOutputBuild: stringMap(stringMap(build)),
  sourceToBuild: stringMap(stringMap(build)),
  sourceToDts: stringMap(stringMap(text)),
  dtsToSource: stringMap(stringMap(text)),
  outputDeclarationCopies: stringMap(copyMap),
  governedSources: stringMap(stringMap(governed)),
  ownershipPlan: ownershipSchema,
  dependencyEdges: z.array(edge),
  manifest: manifestSchema,
  generatedFiles: stringMap(text),
  generatedKnipConfigs: jsonRecords,
  generatedKnipDiagnostics: jsonRecords,
});
export function parseCachedGraph(value: unknown): StoredGraphData | undefined {
  const result = graph.safeParse(value);
  if (!result.success) return undefined;
  const stored = result.data as unknown as StoredGraphData;
  return admittedCachedGraph(stored);
}

function admittedCachedGraph(
  stored: StoredGraphData,
): StoredGraphData | undefined {
  const analysis = stored.dependencyAnalysis;
  const claimed = nativeFingerprint(analysis.outcome);
  finishAnalysisOutcome(
    analysis,
    createProjectDependencyCaches(),
    analysis.outcome!.governance,
  );
  return isConsistentAdmittedOutcome(analysis, claimed) ? stored : undefined;
}

function isConsistentAdmittedOutcome(
  analysis: DependencyAnalysisResult,
  claimed: string,
): boolean {
  return (
    analysis.outcome!.buildAdmission.state === 'admitted' &&
    nativeFingerprint(analysis.outcome) === claimed
  );
}
