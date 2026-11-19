import type { VueProjectSemanticIdentity } from '#checkers';
import type { AnalysisRead } from '#utils/analysis-input';
import { configFileStamp, readStampedConfig } from '#utils/config-file-stamp';
import ts from 'typescript';
import { observedCompilerSystem } from '../typescript-semantic/observed-resolution-host';
import {
  type AnalysisInput,
  AnalysisInputDriftError,
  type InputDependency,
} from './contracts';
import { EpochInputReplay, EpochInputs } from './epoch-inputs';
import { analysisHash } from './identity';
import { inputStat, isRegularFile, readInput } from './input-state';
import type { AnalysisInputs } from './inputs';
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

export function retainVueExecutionInputScope(
  identity: VueProjectSemanticIdentity,
  inputs: EpochInputs,
): void {
  scopes.set(identity, inputs);
}

/** Purposes keep separate semantic identities but execution must watch all
 * reads made on behalf of the same source configuration. */
export function shareVueExecutionInputs(
  source: VueProjectSemanticIdentity,
  purpose: VueProjectSemanticIdentity,
): void {
  scopes.set(purpose, currentScope(source));
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
  if (input.kind === 'config-mtime' || input.kind === 'affecting-mtime') {
    const value = inputs.observedMtime(input.path);
    return {
      value,
      read: () => {
        const stat = inputStat(input.path);
        return isRegularFile(stat) ? stat.mtimeMs : undefined;
      },
    };
  }
  const { metrics } = inputs;
  const { path, kind, version } = input;
  const read = () => readInput({ path, kind, metrics }).version;
  return {
    value: version,
    read: kind === 'content' ? readStampedContent(input, inputs, read) : read,
  };
}

function readStampedContent(
  input: AnalysisInput,
  inputs: AnalysisInputs,
  read: () => string,
): () => string {
  let stamp = input.contentStamp;
  return () => {
    const before = configFileStamp(input.path);
    if (before !== undefined && before === stamp) {
      const { metrics } = inputs;
      metrics.executionContentStampHits =
        (metrics.executionContentStampHits ?? 0) + 1;
      return input.version;
    }
    const { value, configStamp } = readStampedConfig(input.path, read, before);
    if (before !== configStamp) throw new AnalysisInputDriftError(input.path);
    if (value === input.version) stamp = configStamp;
    return value;
  };
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
  for (const dependency of dependencies) {
    scope.bind(dependencyObservation(inputs, dependency), replay);
    const input = inputs.records[dependency.inputId];
    if (input.kind !== 'content') continue;
    const binding = inputs.observe(input.path, 'binding');
    scope.bind(dependencyObservation(inputs, binding), replay);
  }
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
