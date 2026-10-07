import { z } from 'zod';
import {
  checker,
  stringMap,
  stringSet,
  text,
  texts,
} from './cached-data-schema';
import { jsonRecords, manifestSchema } from './cached-manifest-schema';
import { authority, ownershipSchema } from './cached-ownership-schema';
import type {
  DependencyAnalysisResult,
  GeneratedTsconfigGraphResult,
} from './types';
export type CachedGraphData = Omit<
  GeneratedTsconfigGraphResult,
  'artifactPlan' | 'changed'
> & { dependencyAnalysis: DependencyAnalysisResult };
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
const dependencyAnalysis = z.object({
  complete: z.boolean(),
  diagnostics: texts,
  facts: z.array(relation),
});
const graph = z.object({
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
export function parseCachedGraph(value: unknown): CachedGraphData | undefined {
  const result = graph.safeParse(value);
  return result.success
    ? (result.data as unknown as CachedGraphData)
    : undefined;
}
