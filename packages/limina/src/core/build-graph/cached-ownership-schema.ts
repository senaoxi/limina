import { z } from 'zod';
import { checker, stringMap, text, texts } from './cached-data-schema';
export const authority: z.ZodType<unknown> = z.object({
  kind: z.literal('locked'),
  family: z.literal('typescript'),
  source: z.enum(['explicit', 'config', 'root-file', 'dependency']),
});
const evidence = z.object({
  checker,
  configPath: text,
  detail: text,
  source: z.enum([
    'explicit',
    'config',
    'root-file',
    'dependency',
    'build-closure',
    'vue-promotion',
    'solution-constraint',
    'fallback',
  ]),
});
const candidates = stringMap(z.array(evidence));
const owner = z.union([
  z.object({ kind: z.literal('pending') }),
  z.object({ kind: z.literal('resolved'), checker }),
]);
const pendingAuthority = z.union([
  authority,
  z.object({ baseline: z.literal('typescript'), kind: z.literal('pending') }),
]);
const requirement = z
  .object({
    kind: z.enum(['compiler-membership', 'source-semantic']),
    targetFileName: text,
  })
  .nullable();
const occurrence = z.object({
  domain: z.literal('typescript'),
  filePath: text,
  kind: z.enum([
    'static',
    'export',
    'dynamic',
    'import-type',
    'commonjs',
    'require-resolve',
    'import-equals',
    'jsdoc-import',
    'triple-slash-path',
    'triple-slash-types',
    'jsx-import-source',
    'environment-pragma',
  ]),
  line: z.number(),
  locator: z.object({
    occurrence: z.number(),
    sourceStart: z.number(),
    sourceEnd: z.number(),
  }),
  specifier: text,
  configurationSource: z
    .object({
      configPath: text,
      option: z.literal('jsxImportSource'),
      resolutionMode: z.number().optional(),
    })
    .optional(),
});
const dependencyFact = z.object({
  consumerConfigPath: text,
  importRecord: occurrence,
  physicalTargetPath: text.nullable(),
  physicalTargetProvenance: z
    .enum(['checker-source', 'pending-framework-candidate'])
    .nullable(),
  typeEvidenceKind: z.enum([
    'ambient',
    'checker-source',
    'concrete-declaration',
    'missing',
  ]),
  referenceRequirement: requirement.optional(),
});
const solution = z.object({
  configPath: text,
  constraintCandidates: candidates,
  declaredConstraint: checker.optional(),
  finalOwner: checker.optional(),
  kind: z.literal('solution'),
  leafConfigPaths: texts,
});
const typeConfig = z.object({
  authoritativeOwner: checker.optional(),
  configPath: text,
  constraintCandidates: candidates,
  evidence: z.array(evidence),
  finalOwner: checker.optional(),
  frozenSemanticAuthority: authority.optional(),
  kind: z.literal('type'),
  localOwner: owner,
  semanticAuthority: pendingAuthority,
});
export const ownershipSchema: z.ZodType<unknown> = z.object({
  dependencyFacts: z.array(dependencyFact),
  entryOwnerByConfigPath: stringMap(checker),
  solutions: stringMap(solution),
  typeConfigs: stringMap(typeConfig),
});
