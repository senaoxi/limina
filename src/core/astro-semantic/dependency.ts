import type { ImportRecord } from '#core/import-analysis/runner';
import type ts from 'typescript';
import type { FrameworkSemanticCandidate } from '../framework-semantic/contracts';
import type {
  AstroMaterializedServiceScript,
  AstroSemanticContext,
} from './context';

export type AstroSemanticCandidate = FrameworkSemanticCandidate<
  ts.SourceFile,
  ts.StringLiteralLike
>;

export type AstroSemanticCandidateResult =
  | {
      candidates: readonly AstroSemanticCandidate[];
      kind: 'supported';
    }
  | {
      kind: 'unsupported';
      reason: string;
      stage: 'service-script-materialization' | 'source-map-mismatch';
    };

interface ServiceScriptResult {
  kind: 'supported';
  services: ReturnType<AstroSemanticContext['getServiceScripts']>;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rangeIdentity(start: number, end: number): string {
  return JSON.stringify([start, end]);
}

function getLiteralRangeIdentities(
  literal: ts.StringLiteralLike,
  sourceFile: ts.SourceFile,
): readonly string[] {
  const start = literal.getStart(sourceFile);
  const end = literal.getEnd();
  return [rangeIdentity(start, end), rangeIdentity(start + 1, end - 1)];
}

function isMappedLiteral(options: {
  literal: ts.StringLiteralLike;
  rangeIdentities: ReadonlySet<string>;
  sourceFile: ts.SourceFile;
}): boolean {
  return getLiteralRangeIdentities(options.literal, options.sourceFile).some(
    (identity) => options.rangeIdentities.has(identity),
  );
}

function findMappedLiterals(options: {
  rangeIdentities: ReadonlySet<string>;
  sourceFile: ts.SourceFile;
  tsModule: typeof ts;
}): ts.StringLiteralLike[] {
  const literals: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (
      options.tsModule.isStringLiteralLike(node) &&
      isMappedLiteral({ ...options, literal: node })
    ) {
      literals.push(node);
    }
    options.tsModule.forEachChild(node, visit);
  };
  visit(options.sourceFile);
  return literals;
}

export function getAstroMappedRangeIdentities(options: {
  context: AstroSemanticContext;
  importRecord: ImportRecord;
  service: AstroMaterializedServiceScript;
}): ReadonlySet<string> {
  const mapper = options.context.language.maps.get(
    options.service.serviceScript.code,
    options.service.sourceScript,
  );
  const ranges = mapper.toGeneratedRange(
    options.importRecord.locator.sourceStart,
    options.importRecord.locator.sourceEnd,
    false,
  );
  return new Set([...ranges].map(([start, end]) => rangeIdentity(start, end)));
}

function createCandidates(options: {
  context: AstroSemanticContext;
  importRecord: ImportRecord;
  service: AstroMaterializedServiceScript;
}): AstroSemanticCandidate[] {
  const rangeIdentities = getAstroMappedRangeIdentities(options);
  if (rangeIdentities.size === 0) return [];
  const literals = findMappedLiterals({
    rangeIdentities,
    sourceFile: options.service.sourceFile,
    tsModule: options.context.toolchain.tsModule,
  });
  return literals.map((literal) => ({
    containingSourceFile: options.service.sourceFile,
    framework: 'astro',
    identityId: options.context.identity,
    literal,
    provenance: 'strict-source-map',
    semanticSpecifier: literal.text,
    sourceRecord: options.importRecord,
  }));
}

function materializeServiceScripts(options: {
  context: AstroSemanticContext;
  importRecord: ImportRecord;
}): ServiceScriptResult | AstroSemanticCandidateResult {
  try {
    const services = options.context.getServiceScripts(
      options.importRecord.filePath,
    );
    if (services.length > 0) return { kind: 'supported', services };
    return {
      kind: 'unsupported',
      reason:
        'Astro semantic context did not materialize a primary or extra TypeScript service script.',
      stage: 'service-script-materialization',
    };
  } catch (error) {
    return {
      kind: 'unsupported',
      reason: `Astro semantic service-script materialization failed: ${formatError(error)}`,
      stage: 'service-script-materialization',
    };
  }
}

function discoverCandidates(options: {
  context: AstroSemanticContext;
  importRecord: ImportRecord;
  services: ReturnType<AstroSemanticContext['getServiceScripts']>;
}): AstroSemanticCandidateResult {
  try {
    const candidates = options.services.flatMap((service) =>
      createCandidates({ ...options, service }),
    );
    if (candidates.length > 0) return { candidates, kind: 'supported' };
    return {
      kind: 'unsupported',
      reason:
        'Astro source ImportRecord did not map to a strict semantic module literal.',
      stage: 'source-map-mismatch',
    };
  } catch (error) {
    return {
      kind: 'unsupported',
      reason: `Astro source-map candidate discovery failed: ${formatError(error)}`,
      stage: 'source-map-mismatch',
    };
  }
}

export function collectAstroSemanticCandidates(options: {
  context: AstroSemanticContext;
  importRecord: ImportRecord;
}): AstroSemanticCandidateResult {
  options.context.assertActive();
  const services = materializeServiceScripts(options);
  if (!('services' in services)) return services;
  return discoverCandidates({ ...options, services: services.services });
}
