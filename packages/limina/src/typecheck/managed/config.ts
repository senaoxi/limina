import type { GeneratedTsconfigGraphResult } from '#core/build-graph/runner';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import ts from 'typescript';
import { captureConfigDependencyIdentity } from './identity';
import {
  type ConfigDependencyIdentity,
  ManagedCheckerEmitBoundaryError,
  type ManagedLeafClassification,
  type ParsedConfigProof,
} from './types';

function createParseHost(
  reads: Set<string>,
  diagnostics: ts.Diagnostic[],
): ts.ParseConfigFileHost {
  return {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic): void {
      diagnostics.push(diagnostic);
    },
    readFile(fileName): string | undefined {
      const content = ts.sys.readFile(fileName);
      if (content !== undefined) reads.add(normalizeAbsolutePath(fileName));
      return content;
    },
  };
}

function isIgnorableEmptyGeneratedConfig(
  diagnostic: ts.Diagnostic,
  parsed: ts.ParsedCommandLine,
  configPath: string,
): boolean {
  if (diagnostic.code !== 18_002) return false;
  if (parsed.fileNames.length > 0) return false;
  return normalizeAbsolutePath(configPath).split(path.sep).includes('.limina');
}

function getParseErrors(options: {
  configPath: string;
  diagnostics: readonly ts.Diagnostic[];
  parsed: ts.ParsedCommandLine;
}): ts.Diagnostic[] {
  return [...options.diagnostics, ...options.parsed.errors].filter(
    (diagnostic) =>
      !isIgnorableEmptyGeneratedConfig(
        diagnostic,
        options.parsed,
        options.configPath,
      ),
  );
}

function throwConfigDiagnostics(
  configPath: string,
  diagnostics: readonly ts.Diagnostic[],
): never {
  throw new ManagedCheckerEmitBoundaryError(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => path.dirname(configPath),
      getNewLine: () => '\n',
    }),
  );
}

function requireParsedConfig(
  configPath: string,
  parsed: ts.ParsedCommandLine | undefined,
): ts.ParsedCommandLine {
  if (parsed !== undefined) return parsed;
  throw new ManagedCheckerEmitBoundaryError(
    `Unable to parse generated checker config: ${configPath}.`,
  );
}

function assertNoOutFile(
  configPath: string,
  parsed: ts.ParsedCommandLine,
): void {
  if (parsed.options.outFile === undefined) return;
  throw new ManagedCheckerEmitBoundaryError(
    [
      'Managed checker effective compiler options contain outFile:',
      `  config: ${configPath}`,
      `  outFile: ${parsed.options.outFile}`,
      '  reason: outFile is not an authorized Limina managed-output namespace.',
    ].join('\n'),
  );
}

function assertNoParseErrors(options: {
  configPath: string;
  diagnostics: readonly ts.Diagnostic[];
  parsed: ts.ParsedCommandLine;
}): void {
  const errors = getParseErrors(options);
  if (errors.length === 0) return;
  throwConfigDiagnostics(options.configPath, errors);
}

export function parseConfigWithDependencyProof(
  configPath: string,
): ParsedConfigProof {
  const reads = new Set<string>();
  const diagnostics: ts.Diagnostic[] = [];
  const parsed = requireParsedConfig(
    configPath,
    ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      createParseHost(reads, diagnostics),
    ),
  );
  assertNoOutFile(configPath, parsed);
  assertNoParseErrors({ configPath, diagnostics, parsed });
  reads.add(normalizeAbsolutePath(configPath));
  return {
    configDependencies: [...reads]
      .sort((left, right) => left.localeCompare(right))
      .map(captureConfigDependencyIdentity),
    parsed,
  };
}

function addUserOutputBuilds(options: {
  buildsBySource: GeneratedTsconfigGraphResult['configToOutputBuild'] extends Map<
    string,
    infer T
  >
    ? T
    : never;
  checkerName: string;
  classifications: Map<string, ManagedLeafClassification>;
}): void {
  for (const [sourceConfigPath, buildModule] of options.buildsBySource) {
    if (buildModule.kind !== 'project') continue;
    options.classifications.set(normalizeAbsolutePath(buildModule.path), {
      checkerName: options.checkerName,
      kind: 'user-output',
      sourceConfigPath: normalizeAbsolutePath(sourceConfigPath),
    });
  }
}

function addUserOutputClassifications(
  graph: GeneratedTsconfigGraphResult,
  classifications: Map<string, ManagedLeafClassification>,
): void {
  for (const [checkerName, buildsBySource] of graph.configToOutputBuild) {
    addUserOutputBuilds({ buildsBySource, checkerName, classifications });
  }
}

function addInternalDtsClassifications(
  graph: GeneratedTsconfigGraphResult,
  classifications: Map<string, ManagedLeafClassification>,
): void {
  for (const [checkerName, dtsToSource] of graph.dtsToSource) {
    for (const [dtsConfigPath, sourceConfigPath] of dtsToSource) {
      classifications.set(normalizeAbsolutePath(dtsConfigPath), {
        checkerName,
        kind: 'internal-dts',
        sourceConfigPath: normalizeAbsolutePath(sourceConfigPath),
      });
    }
  }
}

export function collectLeafClassifications(
  graph: GeneratedTsconfigGraphResult,
): Map<string, ManagedLeafClassification> {
  const classifications = new Map<string, ManagedLeafClassification>();
  addUserOutputClassifications(graph, classifications);
  addInternalDtsClassifications(graph, classifications);
  return classifications;
}

interface LeafClosureState {
  dependencies: Map<string, ConfigDependencyIdentity>;
  leafPaths: Set<string>;
  queue: string[];
  seen: Set<string>;
}

function addConfigDependencies(
  state: LeafClosureState,
  dependencies: readonly ConfigDependencyIdentity[],
): void {
  for (const dependency of dependencies) {
    state.dependencies.set(dependency.path, dependency);
  }
}

function enqueueReferences(
  state: LeafClosureState,
  references: readonly ts.ProjectReference[] | undefined,
): void {
  if (references === undefined) return;
  for (const reference of references) {
    state.queue.push(normalizeAbsolutePath(reference.path));
  }
}

function visitConfig(
  configPath: string,
  classifications: ReadonlyMap<string, ManagedLeafClassification>,
  state: LeafClosureState,
): void {
  if (state.seen.has(configPath)) return;
  state.seen.add(configPath);
  const proof = parseConfigWithDependencyProof(configPath);
  addConfigDependencies(state, proof.configDependencies);
  if (classifications.has(configPath)) state.leafPaths.add(configPath);
  enqueueReferences(state, proof.parsed.projectReferences);
}

export function collectTargetLeafConfigs(options: {
  classifications: ReadonlyMap<string, ManagedLeafClassification>;
  rootConfigPath: string;
}): {
  dependencies: ConfigDependencyIdentity[];
  leafPaths: string[];
} {
  const state: LeafClosureState = {
    dependencies: new Map(),
    leafPaths: new Set(),
    queue: [normalizeAbsolutePath(options.rootConfigPath)],
    seen: new Set(),
  };
  while (state.queue.length > 0) {
    const configPath = state.queue.shift();
    if (configPath !== undefined) {
      visitConfig(configPath, options.classifications, state);
    }
  }
  return {
    dependencies: [...state.dependencies.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    leafPaths: [...state.leafPaths].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}
