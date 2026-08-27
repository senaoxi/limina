import { resolveTypeScriptModuleNameDetailed } from '#checkers';
import type ts from 'typescript';
import type {
  FrameworkSemanticCandidate,
  FrameworkSemanticDependencyPreparation,
} from '../framework-semantic/contracts';
import type { GeneratedSemanticDependency } from '../framework-semantic/generated-dependencies';
import {
  buildLineStarts,
  createImportRecord,
  type ImportRecord,
} from '../import-analysis/records';
import type { GeneratedSemanticScript } from './generated-script';
import { mapGeneratedRange } from './source-mapping';
import type { SvelteSemanticToolchain } from './toolchain';
import type { SvelteSemanticProject } from './types';

type SvelteCandidate = FrameworkSemanticCandidate<
  ts.SourceFile,
  ts.StringLiteralLike
>;

export interface MappedCandidate {
  candidate: SvelteCandidate;
  resolutionMode: string;
  target: ReturnType<typeof resolveTypeScriptModuleNameDetailed>;
}

type ProjectionFailure = Extract<
  FrameworkSemanticDependencyPreparation,
  { kind: 'unsupported' }
>;

const SOURCE_ONLY_KINDS = new Set([
  'environment-pragma',
  'jsx-import-source',
  'triple-slash-path',
  'triple-slash-types',
]);

function createSourceRecord(options: {
  generatedRecord: GeneratedSemanticDependency['record'];
  range: { end: number; start: number };
  sourceFilePath: string;
  sourceText: string;
}): ImportRecord {
  const collected = createImportRecord({
    end: options.range.end,
    filePath: options.sourceFilePath,
    kind: options.generatedRecord.kind,
    lineOffset: 0,
    lineStarts: buildLineStarts(options.sourceText),
    pos: options.range.start,
    sourceOffset: 0,
    specifier: options.generatedRecord.specifier,
  });
  return {
    domain: collected.domain,
    filePath: collected.filePath,
    kind: collected.kind,
    line: collected.line,
    locator: collected.locator,
    specifier: collected.specifier,
  };
}

function getResolutionMode(options: {
  candidate: SvelteCandidate;
  project: SvelteSemanticProject;
  tsModule: typeof ts;
}): string {
  const resolver = (
    options.tsModule as typeof ts & {
      getModeForUsageLocation?: (
        sourceFile: ts.SourceFile,
        literal: ts.StringLiteralLike,
        compilerOptions: ts.CompilerOptions,
      ) => unknown;
    }
  ).getModeForUsageLocation;
  return resolver === undefined
    ? 'default'
    : String(
        resolver(
          options.candidate.containingSourceFile,
          options.candidate.literal,
          options.project.options,
        ),
      );
}

function createMappedCandidate(options: {
  generated: GeneratedSemanticScript;
  generatedDependency: GeneratedSemanticDependency;
  identity: string;
  project: SvelteSemanticProject;
  range: { end: number; start: number };
  sourceFilePath: string;
  sourceText: string;
  toolchain: SvelteSemanticToolchain;
}): MappedCandidate | null {
  const literal = options.generatedDependency.literal;
  if (literal === null) return null;
  const candidate: SvelteCandidate = {
    containingSourceFile: options.generated.sourceFile,
    framework: 'svelte',
    identityId: options.identity,
    literal,
    provenance: 'strict-source-map',
    semanticSpecifier: options.generatedDependency.record.specifier,
    sourceRecord: createSourceRecord({
      generatedRecord: options.generatedDependency.record,
      range: options.range,
      sourceFilePath: options.sourceFilePath,
      sourceText: options.sourceText,
    }),
  };
  return {
    candidate,
    resolutionMode: getResolutionMode({
      candidate,
      project: options.project,
      tsModule: options.toolchain.tsModule,
    }),
    target: resolveTypeScriptModuleNameDetailed({
      compilerOptions: options.project.options,
      containingFile: options.generated.sourceFile.fileName,
      extensions: [...options.project.extensions],
      specifier: candidate.semanticSpecifier,
      tsModule: options.toolchain.tsModule,
    }),
  };
}

function createFailure(reason: string): ProjectionFailure {
  return { kind: 'unsupported', reason, stage: 'source-map-mismatch' };
}

type ProjectionResult = MappedCandidate | ProjectionFailure | null;

function classifyMappedDependency(options: {
  dependency: GeneratedSemanticDependency;
  directSourceRecords: ImportRecord[];
  generated: GeneratedSemanticScript;
  identity: string;
  project: SvelteSemanticProject;
  range: { end: number; start: number };
  sourceFilePath: string;
  sourceText: string;
  toolchain: SvelteSemanticToolchain;
}): ProjectionResult {
  if (SOURCE_ONLY_KINDS.has(options.dependency.record.kind)) {
    options.directSourceRecords.push(
      createSourceRecord({
        generatedRecord: options.dependency.record,
        range: options.range,
        sourceFilePath: options.sourceFilePath,
        sourceText: options.sourceText,
      }),
    );
    return null;
  }
  const candidate = createMappedCandidate({
    ...options,
    generatedDependency: options.dependency,
  });
  return (
    candidate ??
    createFailure(
      'Svelte generated dependency did not identify a TypeScript module literal.',
    )
  );
}

function projectDependency(options: {
  dependency: GeneratedSemanticDependency;
  directSourceRecords: ImportRecord[];
  generated: GeneratedSemanticScript;
  identity: string;
  project: SvelteSemanticProject;
  sourceFilePath: string;
  sourceLineStarts: readonly number[];
  sourceText: string;
  toolchain: SvelteSemanticToolchain;
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): ProjectionResult {
  const mapping = mapGeneratedRange({
    generatedLineStarts: options.generated.lineStarts,
    generatedRecord: options.dependency.record,
    sourceFilePath: options.sourceFilePath,
    sourceLineStarts: options.sourceLineStarts,
    trace: options.generated.trace,
  });
  if (mapping.kind === 'source-map-mismatch') {
    return createFailure(mapping.reason);
  }
  if (mapping.kind === 'unmapped') {
    options.unmapped.push({
      generatedFilePath: options.generated.filePath,
      semanticSpecifier: options.dependency.record.specifier,
    });
    return null;
  }
  return classifyMappedDependency({ ...options, range: mapping.range });
}

function appendProjection(
  resolved: MappedCandidate[],
  projected: ProjectionResult,
): ProjectionFailure | null {
  if (projected === null) return null;
  if ('kind' in projected) return projected;
  resolved.push(projected);
  return null;
}

export function collectSvelteMappedCandidates(options: {
  dependencies: readonly GeneratedSemanticDependency[];
  directSourceRecords: ImportRecord[];
  generated: GeneratedSemanticScript;
  identity: string;
  project: SvelteSemanticProject;
  sourceFilePath: string;
  sourceText: string;
  toolchain: SvelteSemanticToolchain;
  unmapped: Extract<
    FrameworkSemanticDependencyPreparation,
    { kind: 'supported' }
  >['unmapped'];
}): { kind: 'supported'; resolved: MappedCandidate[] } | ProjectionFailure {
  const resolved: MappedCandidate[] = [];
  const sourceLineStarts = buildLineStarts(options.sourceText);
  for (const dependency of options.dependencies) {
    const failure = appendProjection(
      resolved,
      projectDependency({ ...options, dependency, sourceLineStarts }),
    );
    if (failure !== null) return failure;
  }
  return { kind: 'supported', resolved };
}
