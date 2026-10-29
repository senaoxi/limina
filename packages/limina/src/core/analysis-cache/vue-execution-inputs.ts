import type { VueProjectSemanticIdentity } from '#checkers';
import type { AnalysisRead } from '#utils/analysis-input';
import ts from 'typescript';
import { observedCompilerSystem } from '../typescript-semantic/observed-resolution-host';
import {
  type AnalysisInput,
  AnalysisInputDriftError,
  type InputDependency,
} from './contracts';
import { PathBindingReplay } from './directory-fingerprint';
import { EpochInputReplay, EpochInputs } from './epoch-inputs';
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

/** Purposes keep separate semantic identities but execution must watch all
 * reads made on behalf of the same source configuration. */
export function shareVueExecutionInputs(
  source: VueProjectSemanticIdentity,
  purpose: VueProjectSemanticIdentity,
): void {
  scopes.set(purpose, currentScope(source));
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
  replay: EpochInputReplay = new EpochInputReplay(),
): void {
  const scope = currentScope(identity);
  // Reuse ancestor bindings only during this synchronous receipt-binding batch.
  // Execution admission still replays these inputs in a fresh validation scope.
  new PathBindingReplay().run(() => {
    for (const dependency of dependencies)
      scope.bind(dependencyObservation(inputs, dependency), replay);
  });
}
function dependencyObservation(
  inputs: AnalysisInputs,
  dependency: InputDependency,
): AnalysisRead {
  const input = inputs.records[dependency.inputId];
  if (input?.version !== dependency.expectedVersion)
    throw new Error('Vue execution input receipt is unbound.');
  return {
    path: input.path,
    key: dependency.inputId,
    ...dependencyRead(input, inputs),
  };
}
