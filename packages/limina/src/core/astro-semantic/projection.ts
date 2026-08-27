import type ts from 'typescript';
import type {
  FrameworkSemanticCandidate,
  FrameworkSemanticDependencyPreparation,
} from '../framework-semantic/contracts';
import {
  enumerateGeneratedSemanticDependencies,
  type GeneratedSemanticDependency,
} from '../framework-semantic/generated-dependencies';
import { strictBackprojectVolarDependency } from '../framework-semantic/volar-backprojection';
import type { ImportRecord } from '../import-analysis/records';
import type {
  AstroMaterializedServiceScript,
  AstroSemanticContext,
} from './context';

type AstroCandidate = FrameworkSemanticCandidate<
  ts.SourceFile,
  ts.StringLiteralLike
>;

type PreparationFailure = Extract<
  FrameworkSemanticDependencyPreparation,
  { kind: 'unsupported' }
>;

type ProjectedCandidate = AstroCandidate | PreparationFailure | null;

const SOURCE_ONLY_KINDS = new Set([
  'environment-pragma',
  'jsx-import-source',
  'triple-slash-path',
  'triple-slash-types',
]);

function createFailure(
  reason: string,
  stage: PreparationFailure['stage'],
): PreparationFailure {
  return { kind: 'unsupported', reason, stage };
}

function handleMappedProjection(options: {
  context: AstroSemanticContext;
  dependency: GeneratedSemanticDependency;
  directSourceRecords: ImportRecord[];
  projection: Extract<
    ReturnType<typeof strictBackprojectVolarDependency>,
    { kind: 'mapped' }
  >;
  service: AstroMaterializedServiceScript;
}): ProjectedCandidate {
  if (SOURCE_ONLY_KINDS.has(options.dependency.record.kind)) {
    options.directSourceRecords.push(options.projection.sourceRecord);
    return null;
  }
  if (options.dependency.literal === null) {
    return createFailure(
      'Astro generated dependency did not identify a TypeScript module literal.',
      'source-map-mismatch',
    );
  }
  return {
    containingSourceFile: options.service.sourceFile,
    framework: 'astro',
    identityId: options.context.identity,
    literal: options.dependency.literal,
    provenance: 'strict-source-map',
    semanticSpecifier: options.dependency.record.specifier,
    sourceRecord: options.projection.sourceRecord,
  };
}

function handleNonUnmappedProjection(options: {
  context: AstroSemanticContext;
  dependency: GeneratedSemanticDependency;
  directSourceRecords: ImportRecord[];
  projection: Exclude<
    ReturnType<typeof strictBackprojectVolarDependency>,
    { kind: 'unmapped' }
  >;
  service: AstroMaterializedServiceScript;
}): ProjectedCandidate {
  if (options.projection.kind === 'source-map-ambiguity') {
    return createFailure(
      'Astro generated dependency strictly projected to multiple source ranges.',
      'source-map-ambiguity',
    );
  }
  if (options.projection.kind === 'source-map-mismatch') {
    return createFailure(options.projection.reason, 'source-map-mismatch');
  }
  return handleMappedProjection({ ...options, projection: options.projection });
}

function projectDependency(options: {
  context: AstroSemanticContext;
  dependency: GeneratedSemanticDependency;
  directSourceRecords: ImportRecord[];
  filePath: string;
  mapper: Parameters<typeof strictBackprojectVolarDependency>[0]['mapper'];
  service: AstroMaterializedServiceScript;
  sourceText: string;
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): ProjectedCandidate {
  const projection = strictBackprojectVolarDependency({
    dependency: options.dependency,
    mapper: options.mapper,
    sourceFilePath: options.filePath,
    sourceText: options.sourceText,
  });
  if (projection.kind !== 'unmapped') {
    return handleNonUnmappedProjection({ ...options, projection });
  }
  options.unmapped.push({
    generatedFilePath: options.dependency.generatedFilePath,
    semanticSpecifier: options.dependency.record.specifier,
  });
  return null;
}

function appendProjectedCandidate(
  candidates: AstroCandidate[],
  projected: ProjectedCandidate,
): PreparationFailure | null {
  if (projected === null) return null;
  if ('kind' in projected) return projected;
  candidates.push(projected);
  return null;
}

export function mapAstroServiceCandidates(options: {
  context: AstroSemanticContext;
  directSourceRecords: ImportRecord[];
  filePath: string;
  service: AstroMaterializedServiceScript;
  sourceText: string;
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): { candidates: AstroCandidate[]; kind: 'supported' } | PreparationFailure {
  const mapper = options.context.language.maps.get(
    options.service.serviceScript.code,
    options.service.sourceScript,
  );
  const candidates: AstroCandidate[] = [];
  const dependencies = enumerateGeneratedSemanticDependencies({
    generatedFilePath: options.service.sourceFile.fileName,
    sourceFile: options.service.sourceFile,
    tsModule: options.context.toolchain.tsModule,
  });
  for (const dependency of dependencies) {
    const failure = appendProjectedCandidate(
      candidates,
      projectDependency({ ...options, dependency, mapper }),
    );
    if (failure !== null) return failure;
  }
  return { candidates, kind: 'supported' };
}
