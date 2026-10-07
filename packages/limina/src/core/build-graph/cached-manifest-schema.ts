import { z } from 'zod';
import { checker, text, texts } from './cached-data-schema';
const json = z.json();
export const jsonRecord: z.ZodType<unknown> = z.record(text, json);
export const jsonRecords: z.ZodType<unknown> = z.array(jsonRecord);
const manifestBuild = z.object({
  kind: z.enum(['project', 'solution']),
  path: text,
});
const buildRecord = z.record(text, manifestBuild);
const textRecord = z.record(text, text);
const checkerManifest = z.object({
  configToOutputBuild: buildRecord,
  entry: text,
  name: text,
  roots: texts,
  sourceToBuild: buildRecord,
  sourceToDts: textRecord,
  dtsToSource: textRecord,
});
const dependencyEdge = z.object({
  file: text,
  fromChecker: text,
  fromConfig: text,
  importedSpecifier: text,
  resolvedFile: text,
  toChecker: text,
  toConfig: text,
  kind: z.literal('declaration-provider'),
  cacheReuse: z.enum(['non-reusable', 'reusable']),
});
const configOwner = z.object({
  config: text,
  owner: checker,
  role: z.enum(['solution', 'type']),
});
const solutionOwner = z.object({ config: text, leaves: texts, owner: checker });
const ownership = z.object({
  configs: z.array(configOwner),
  solutions: z.array(solutionOwner),
});
const buildTarget = z.object({ checker, entry: text, roots: texts });
const emptyFrameworks = z.array(z.never());
const targets = z.object({
  build: z.array(buildTarget),
  framework: emptyFrameworks,
});
const knip = z.object({ diagnostics: jsonRecords, packages: jsonRecords });
export const manifestSchema: z.ZodType<unknown> = z.object({
  version: z.literal(5),
  generatedBy: z.literal('limina'),
  ownedArtifacts: texts,
  checkers: z.record(text, checkerManifest),
  knip,
  dependencyEdges: z.array(dependencyEdge),
  ownership,
  targets,
});
