import type { VolarSourceScript, VueSourceProfile } from '#checkers';
import type { ImportRecord } from '#core/import-analysis/runner';
import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import type { FrameworkSemanticCandidate } from '../framework-semantic/contracts';
import { rangeIdentity } from '../framework-semantic/generated-dependencies';
import type { VueSemanticContext } from './context';

export type SemanticDependencyEvidence = FrameworkSemanticCandidate<
  ts.SourceFile,
  ts.StringLiteralLike,
  VueSourceProfile
>;

export type SemanticDependencyResult =
  | {
      candidates: readonly SemanticDependencyEvidence[];
      kind: 'supported';
    }
  | {
      kind: 'unsupported';
      reason: string;
    };

type GeneratedVueScript = NonNullable<VolarSourceScript['generated']>;
type VueTypeScriptProvider = NonNullable<
  GeneratedVueScript['languagePlugin']['typescript']
>;
type VueServiceScript = NonNullable<
  ReturnType<VueTypeScriptProvider['getServiceScript']>
>;

export interface VueServiceScriptPair {
  serviceScript: VueServiceScript;
  sourceScript: VolarSourceScript;
}

function getLiteralRangeIdentities(
  literal: ts.StringLiteralLike,
  sourceFile: ts.SourceFile,
): readonly string[] {
  const start = literal.getStart(sourceFile);
  const end = literal.getEnd();
  return [rangeIdentity(start, end), rangeIdentity(start + 1, end - 1)];
}

function isLiteralInMappedRanges(options: {
  literal: ts.StringLiteralLike;
  rangeIdentities: ReadonlySet<string>;
  sourceFile: ts.SourceFile;
}): boolean {
  return getLiteralRangeIdentities(options.literal, options.sourceFile).some(
    (identity) => options.rangeIdentities.has(identity),
  );
}

function findLiteralsAtRanges(options: {
  rangeIdentities: ReadonlySet<string>;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): ts.StringLiteralLike[] {
  const literals: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (
      options.tsModule.isStringLiteralLike(node) &&
      isLiteralInMappedRanges({ ...options, literal: node })
    ) {
      literals.push(node);
    }
    options.tsModule.forEachChild(node, visit);
  };
  visit(options.sourceFile);
  return literals;
}

function getGeneratedScript(
  sourceScript: VolarSourceScript,
): GeneratedVueScript | null {
  return sourceScript.generated ?? null;
}

function getGeneratedServiceScript(
  generated: NonNullable<VolarSourceScript['generated']>,
): VueServiceScript | null {
  const provider = generated.languagePlugin.typescript;
  if (provider === undefined) return null;
  return provider.getServiceScript(generated.root) ?? null;
}

function createServiceScriptPair(
  sourceScript: VolarSourceScript,
): VueServiceScriptPair | null {
  const generated = getGeneratedScript(sourceScript);
  if (generated === null) return null;
  const serviceScript = getGeneratedServiceScript(generated);
  if (serviceScript === null) return null;
  return { serviceScript, sourceScript };
}

export function getVueServiceScript(options: {
  context: VueSemanticContext;
  fileName: string;
}): VueServiceScriptPair | null {
  const sourceScript = options.context.language.scripts.get(
    normalizeAbsolutePath(options.fileName),
  );
  return sourceScript === undefined
    ? null
    : createServiceScriptPair(sourceScript);
}

export function getVueMappedRangeIdentities(options: {
  context: VueSemanticContext;
  importRecord: ImportRecord;
}): ReadonlySet<string> | null {
  const service = getVueServiceScript({
    context: options.context,
    fileName: options.importRecord.filePath,
  });
  if (service === null) return null;
  const mapper = options.context.language.maps.get(
    service.serviceScript.code,
    service.sourceScript,
  );
  const ranges = [
    ...mapper.toGeneratedRange(
      options.importRecord.locator.sourceStart,
      options.importRecord.locator.sourceEnd,
      false,
    ),
  ];
  if (ranges.length === 0) return null;
  return new Set(ranges.map(([start, end]) => rangeIdentity(start, end)));
}

export function createVueEvidence(options: {
  context: VueSemanticContext;
  importRecord: ImportRecord;
  literals: readonly ts.StringLiteralLike[];
  profile?: VueSourceProfile;
  provenance: SemanticDependencyEvidence['provenance'];
}): SemanticDependencyEvidence[] {
  return options.literals.map((literal) => ({
    containingSourceFile: literal.getSourceFile(),
    framework: 'vue',
    identityId: options.context.identity.id,
    literal,
    profile: options.profile,
    provenance: options.provenance,
    semanticSpecifier: literal.text,
    sourceRecord: options.importRecord,
  }));
}

function createUnsupported(reason: string): SemanticDependencyResult {
  return { kind: 'unsupported', reason };
}

function collectMappedLiterals(
  options: {
    context: VueSemanticContext;
    importRecord: ImportRecord;
    profile: VueSourceProfile;
  },
  ranges: ReadonlySet<string>,
): SemanticDependencyResult {
  const sourceFile = options.context.getSemanticSourceFile(
    normalizeAbsolutePath(options.importRecord.filePath),
  );
  if (sourceFile === undefined) {
    return createUnsupported(
      'Vue semantic Program does not contain the mapped source file.',
    );
  }
  const literals = findLiteralsAtRanges({
    rangeIdentities: ranges,
    sourceFile,
    tsModule: options.context.tsModule,
  });
  if (literals.length === 0) {
    return createUnsupported(
      'Vue strict source-map ranges did not identify a semantic module literal.',
    );
  }
  return {
    candidates: createVueEvidence({
      ...options,
      literals,
      provenance: 'strict-source-map',
    }),
    kind: 'supported',
  };
}

function collectMappedDependency(options: {
  context: VueSemanticContext;
  importRecord: ImportRecord;
  profile: VueSourceProfile;
}): SemanticDependencyResult {
  const ranges = getVueMappedRangeIdentities(options);
  return ranges === null
    ? createUnsupported(
        'Vue source dependency did not map to a strict semantic service-script range.',
      )
    : collectMappedLiterals(options, ranges);
}

function collectDirectDependency(options: {
  context: VueSemanticContext;
  importRecord: ImportRecord;
}): SemanticDependencyResult {
  const sourceFile = options.context.getSemanticSourceFile(
    normalizeAbsolutePath(options.importRecord.filePath),
  );
  if (sourceFile === undefined) {
    return createUnsupported(
      'Vue semantic Program does not contain the source file.',
    );
  }
  const targetRange = rangeIdentity(
    options.importRecord.locator.sourceStart,
    options.importRecord.locator.sourceEnd,
  );
  const literals = findLiteralsAtRanges({
    rangeIdentities: new Set([targetRange]),
    sourceFile,
    tsModule: options.context.tsModule,
  }).filter((literal) => literal.text === options.importRecord.specifier);
  if (literals.length !== 1) {
    return createUnsupported(
      'Native source dependency did not identify one direct semantic module literal.',
    );
  }
  return {
    candidates: createVueEvidence({
      ...options,
      literals,
      provenance: 'direct-source',
    }),
    kind: 'supported',
  };
}

export function collectSemanticDependencyEvidence(options: {
  context: VueSemanticContext;
  importRecord: ImportRecord;
}): SemanticDependencyResult {
  options.context.assertActive();
  const profile = options.context.identity.profilesByFileName.get(
    normalizeAbsolutePath(options.importRecord.filePath),
  );
  return profile === undefined
    ? collectDirectDependency(options)
    : collectMappedDependency({ ...options, profile });
}
