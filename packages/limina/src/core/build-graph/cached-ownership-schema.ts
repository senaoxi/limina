import { z } from 'zod';
import { nativeFactEvidenceSchema } from '../analysis-cache/native-obligation-schema';
import { checker, stringMap, text, texts } from './cached-data-schema';
import { declarationContextSchema } from './cached-declaration-schema';
export const authority: z.ZodType<unknown> = z.object({
  kind: z.literal('locked'),
  family: z.enum(['typescript', 'vue', 'astro', 'svelte']),
  source: z.enum(['explicit', 'config', 'baseline']),
});
const evidence = z.object({
  checker: z.enum(['tsc', 'tsgo', 'vue-tsc', 'astro', 'svelte-check']),
  configPath: text,
  detail: text,
  source: z.enum([
    'explicit',
    'config',
    'build-closure',
    'vue-promotion',
    'fallback',
  ]),
});
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
  compilerRequest: z
    .object({
      contextConfig: text,
      fileName: text,
      role: z.enum(['import', 'augmentation']),
      mode: z.number().optional(),
      occurrence: z.number(),
      start: z.number(),
      end: z.number(),
    })
    .optional(),
  domain: z.enum([
    'typescript',
    'vue-script',
    'vue-script-attribute',
    'vue-generic-attribute',
    'astro-frontmatter',
    'astro-client-script',
  ]),
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
    'module-augmentation',
    'vue-script-src',
    'vue-generic-type',
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
      option: z.enum(['jsxImportSource', 'importHelpers']),
      resolutionMode: z.number().optional(),
    })
    .optional(),
});
const dependencyFact = z.object({
  nativeEvidence: nativeFactEvidenceSchema.optional(),
  consumerConfigPath: text,
  importRecord: occurrence,
  physicalTargetPath: text.nullable(),
  physicalTargetProvenance: z.literal('checker-source').nullable(),
  typeEvidenceKind: z.enum([
    'ambient',
    'checker-source',
    'concrete-declaration',
    'missing',
    'unobserved',
  ]),
  referenceRequirement: requirement.optional(),
});
const solution = z.object({
  configPath: text,
  declaredConstraint: checker.optional(),
  kind: z.literal('solution'),
  sourceConfigPaths: texts,
});
const typeConfig = z.object({
  authoritativeOwner: checker.optional(),
  configPath: text,
  evidence: z.array(evidence),
  finalOwner: checker.optional(),
  frozenSemanticAuthority: authority.optional(),
  kind: z.literal('type'),
  localOwner: owner,
  semanticAuthority: pendingAuthority,
});
export const ownershipSchema: z.ZodType<unknown> = z.object({
  coloringInputs: z.object({
    version: z.literal(1),
    seeds: stringMap(typeConfig),
  }),
  declarationContexts: z.array(declarationContextSchema).optional(),
  dependencyFactPhase: z.literal('locked'),
  dependencyFacts: z.array(dependencyFact),
  sourceConfigPathsByEntry: stringMap(texts),
  solutions: stringMap(solution),
  typeConfigs: stringMap(typeConfig),
});
