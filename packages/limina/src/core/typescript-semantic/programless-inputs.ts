import ts from 'typescript';
import { AnalysisInputDriftError } from '../analysis-cache/contracts';
import { analysisHash } from '../analysis-cache/identity';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import {
  extractFileDependencyFacts,
  type FileDependencyFacts,
} from './file-dependency-facts';
import type { SourceSyntaxFactsCache } from './syntax-cache';

interface SyntaxInput {
  file: string;
  cache?: NativeAnalysisCache;
  syntaxFacts?: SourceSyntaxFactsCache;
  host: ts.ModuleResolutionHost;
}
export function noteNativeMetric(
  cache: NativeAnalysisCache | undefined,
  metric: string,
): void {
  cache?.increment(metric);
}
function priorFacts(input: SyntaxInput): FileDependencyFacts | undefined {
  if (input.cache === undefined) return undefined;
  const { cache, file } = input;
  const content = cache.inputs.observe(file, 'content');
  cache.inputs.consume([content, cache.inputs.observe(file, 'binding')]);
  const prior = cache.files[file] ?? previousFacts(cache, file);
  return qualifiedPrior(prior, content.expectedVersion);
}
function qualifiedPrior(
  prior: FileDependencyFacts | undefined,
  version: string,
): FileDependencyFacts | undefined {
  if (prior === undefined) return undefined;
  return [
    prior.sourceVersion === version,
    prior.compilerVersion === ts.version,
    prior.version === 1,
  ].every(Boolean)
    ? prior
    : undefined;
}
function retain(
  input: SyntaxInput,
  facts: FileDependencyFacts,
): FileDependencyFacts {
  if (input.cache !== undefined) input.cache.files[input.file] = facts;
  return facts;
}
function assertVersion(input: SyntaxInput, version: string): void {
  const expected = input.cache?.inputs.observe(
    input.file,
    'content',
  ).expectedVersion;
  if (isInvalidVersion(expected, version))
    throw new AnalysisInputDriftError(input.file);
}
function extract(
  input: SyntaxInput,
  text: string,
  version: string,
): FileDependencyFacts {
  noteNativeMetric(input.cache, 'syntaxExtractions');
  const facts = extractFileDependencyFacts(input.file, text, version);
  input.syntaxFacts?.setDependencyFacts(facts);
  return retain(input, facts);
}
function sharedOrExtracted(
  input: SyntaxInput,
  text: string,
): FileDependencyFacts {
  const version = analysisHash(text);
  assertVersion(input, version);
  const shared = input.syntaxFacts?.getDependencyFacts(input.file, version);
  if (shared === undefined) return extract(input, text, version);
  noteNativeMetric(input.cache, 'syntaxFactHits');
  return retain(input, shared);
}
export function loadDependencyFacts(
  input: SyntaxInput,
): FileDependencyFacts | undefined {
  const prior = priorFacts(input);
  if (prior !== undefined) {
    noteNativeMetric(input.cache, 'syntaxFactHits');
    return retain(input, prior);
  }
  const text = input.host.readFile(input.file);
  return text === undefined ? undefined : sharedOrExtracted(input, text);
}

function previousFacts(
  cache: NativeAnalysisCache,
  file: string,
): FileDependencyFacts | undefined {
  return cache.previous?.files[file];
}
function isInvalidVersion(
  expected: string | undefined,
  version: string,
): boolean {
  return expected !== undefined && expected !== version;
}
