import { isNativeTypeScriptProjectInput } from '#checkers';
import { readAnalysisInput } from '#utils/analysis-input';
import { configFileStamp } from '#utils/config-file-stamp';
import { digestFile } from '#utils/file-digest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';
import type { NativeEvidenceContext } from '../../domain/analysis/native-context';
import type { SourceConfigCoverageIndex } from '../../domain/analysis/native-coverage';
import { prepareTypeScriptContentObservation } from '../analysis-cache/epoch-inputs';
import type { NativeAnalysisCache } from '../analysis-cache/native-cache';
import { BoundedResolutionQueries } from './bounded-resolution-queries';
import type { TypeScriptSemanticProject } from './contracts';
import { nativeFingerprint } from './native-file-identity';
import type { NativeProgramObservationOptions } from './native-observation-adapter';
import { createNativeObservationContext } from './native-observation-context';
import { NativeObservationError } from './native-observation-failure';

const require = createRequire(import.meta.url);
const systemReadFile = ts.sys.readFile;

const compilerImplementations = new WeakMap<
  NativeAnalysisCache,
  {
    path: string;
    stamp: string;
    fingerprint: string;
    observe(): void;
  }
>();

/**
Actual loaded baseline and input identity, independent of final Checker startup.
*/
export function nativeContextInputs(
  input: TypeScriptSemanticProject,
  cache?: NativeAnalysisCache,
): NativeProgramObservationOptions {
  const project = {
    ...input,
    fileNames: input.fileNames.filter(isNativeTypeScriptProjectInput),
  };
  const coverage =
    project.workspaceSourceBoundary.sourceConfigCoverage ??
    unavailableCoverage(project);
  const typescriptImplementation = compilerImplementation(cache);
  const sourceVersion = nativeFingerprint(
    project.fileNames.map((file) => [file, rootVersion(file, project, cache)]),
  );
  const authority = nativeAuthority(project);
  return {
    project,
    coverage,
    queries: cache?.supports(project, ts)
      ? new BoundedResolutionQueries(cache, project)
      : undefined,
    context: createNativeObservationContext({
      project,
      coverage,
      sourceVersion,
      authority,
      epoch: coverage.inputVersion,
      collectionId: randomUUID(),
      typescriptVersion: ts.version,
      typescriptImplementation,
      toolchain: nativeFingerprint([process.execPath, process.versions]),
    }),
  };
}

function compilerImplementation(cache?: NativeAnalysisCache): string {
  const path = require.resolve('typescript');
  const stamp =
    cache !== undefined && ts.sys.readFile === systemReadFile
      ? configFileStamp(path)
      : undefined;
  if (cache === undefined || stamp === undefined)
    return implementationFingerprint(
      path,
      readAnalysisInput(
        path,
        () => ts.sys.readFile(path),
        'typescript-content',
      ),
    );
  const prior = compilerImplementations.get(cache);
  if (prior?.path === path && prior.stamp === stamp) {
    prior.observe();
    return prior.fingerprint;
  }
  const input = prepareTypeScriptContentObservation(path);
  input.observe();
  const fingerprint = implementationFingerprint(path, input.value);
  if (stamp === configFileStamp(path))
    compilerImplementations.set(cache, {
      path,
      stamp,
      fingerprint,
      observe: input.observe,
    });
  return fingerprint;
}

function implementationFingerprint(
  path: string,
  content: string | undefined,
): string {
  if (content === undefined)
    throw new NativeObservationError(
      'file-read',
      `Cannot read the loaded TypeScript implementation: ${path}`,
    );
  return nativeFingerprint([path, content]);
}

function rootVersion(
  file: string,
  project: TypeScriptSemanticProject,
  cache: NativeAnalysisCache | undefined,
): string | null {
  const virtual = project.virtualFiles?.get(file);
  if (virtual !== undefined) return nativeFingerprint(virtual);
  return readAnalysisInput(file, () => ts.sys.fileExists(file), 'file')
    ? readAnalysisInput(
        file,
        () => cache?.inputs.sourceDigest(file) ?? digestFile(file).hash,
        'source-digest',
      )
    : null;
}

function nativeAuthority(
  project: TypeScriptSemanticProject,
): NativeEvidenceContext['authority'] {
  if (project.analysisBinding?.phase === 'locked')
    return {
      phase: 'locked',
      family: 'typescript',
      selectionEvidenceIds: [
        nativeFingerprint(['native-baseline', project.analysisBinding]),
      ],
    };
  return { phase: 'pending', baseline: 'typescript' };
}

function unavailableCoverage(
  project: TypeScriptSemanticProject,
): SourceConfigCoverageIndex {
  const id = nativeFingerprint(['unavailable-universe', project.configPath]);
  return {
    inputVersion: 'unavailable',
    configurations: [],
    universe: {
      id,
      revision: id,
      scopeFingerprint: id,
      inputVersion: 'unavailable',
      selectionEvidenceId: 'source-config-universe-not-provided',
      sourceConfigIds: [],
      discovery: 'open',
    },
  };
}
