import type { VueProjectSemanticIdentity } from '#checkers';
import { type AnalysisRead, observeAnalysisRead } from '#utils/analysis-input';
import ts from 'typescript';
import { observedCompilerSystem } from '../typescript-semantic/observed-resolution-host';
import {
  type AnalysisInput,
  AnalysisInputDriftError,
  type InputDependency,
} from './contracts';
import { EpochInputs } from './epoch-inputs';
import { analysisHash } from './identity';
import { readInput } from './input-state';
import type { AnalysisInputs } from './inputs';
import { manifestField } from './manifest-input';
import type { VueInputTrace } from './vue-inputs';

const scopes = new WeakMap<VueProjectSemanticIdentity, EpochInputs>();
const observedMethods = new Set([
  'readFile',
  'fileExists',
  'directoryExists',
  'getDirectories',
  'realpath',
  'readDirectory',
]);
function currentScope(identity: VueProjectSemanticIdentity): EpochInputs {
  const inputs = scopes.get(identity) ?? new EpochInputs();
  scopes.set(identity, inputs);
  return inputs;
}

/**
Retain the actual Vue compiler reads independently of persistent caching.
*/
export function observeVueExecutionSystem(
  identity: VueProjectSemanticIdentity,
  system: ts.System,
  trace?: VueInputTrace,
): ts.System {
  const inputs = currentScope(identity);
  const observed = observedCompilerSystem(
    identity.toolchain.tsModule,
    identity.configPath,
    system,
  );
  const scoped = new Proxy(observed, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return observedMethods.has(String(key))
        ? (...arguments_: unknown[]) =>
            inputs.collect(() => value.apply(target, arguments_))
        : value;
    },
  });
  return trace === undefined ? scoped : trace.system(scoped);
}

export function vueExecutionInputs(
  identity: VueProjectSemanticIdentity | undefined,
): EpochInputs {
  const inputs = identity === undefined ? undefined : scopes.get(identity);
  if (inputs === undefined)
    throw new Error('Vue execution input observations are unavailable.');
  return inputs;
}
export function retainVueExecutionInputs(
  source: VueProjectSemanticIdentity,
  reused: VueProjectSemanticIdentity,
): void {
  scopes.set(reused, vueExecutionInputs(source));
}

function versionRead(input: AnalysisInput, inputs: AnalysisInputs): string {
  const options = { path: input.path, metrics: inputs.metrics };
  return input.kind === 'imports' || input.kind === 'exports'
    ? manifestField(readInput({ ...options, kind: 'content' }), input.kind)
        .version
    : readInput({ ...options, kind: input.kind }).version;
}

function dependencyRead(
  input: AnalysisInput,
  inputs: AnalysisInputs,
): Pick<AnalysisRead, 'read' | 'value' | 'descriptor'> {
  if (input.kind === 'directory')
    return structuralRead(input, () => ts.sys.directoryExists(input.path));
  if (input.kind === 'directories')
    return structuralRead(input, () =>
      ts.sys.directoryExists(input.path)
        ? ts.sys.getDirectories(input.path)
        : [],
    );
  // Re-read against the authenticated record, without memoized .valid() or mtime reuse.
  return { value: input.version, read: () => versionRead(input, inputs) };
}

function structuralRead(
  input: AnalysisInput,
  read: () => unknown,
): Pick<AnalysisRead, 'read' | 'value' | 'descriptor'> {
  const value = read();
  if (analysisHash(value) !== input.version)
    throw new AnalysisInputDriftError(input.path);
  return {
    value,
    read,
    descriptor: {
      kind: input.kind as 'directory' | 'directories',
      path: input.path,
    },
  };
}

/**
Rebind only dependencies of this qualified Vue context to live replay.
*/
export function bindVueExecutionInputs(
  identity: VueProjectSemanticIdentity,
  inputs: AnalysisInputs,
  dependencies: Iterable<InputDependency>,
): void {
  const scope = currentScope(identity);
  scope.run(() => {
    for (const dependency of dependencies) bindDependency(inputs, dependency);
  });
}
function bindDependency(
  inputs: AnalysisInputs,
  dependency: InputDependency,
): void {
  const input = inputs.records[dependency.inputId];
  if (input?.version !== dependency.expectedVersion)
    throw new Error('Vue execution input receipt is unbound.');
  observeAnalysisRead({
    path: input.path,
    key: dependency.inputId,
    ...dependencyRead(input, inputs),
  });
}
