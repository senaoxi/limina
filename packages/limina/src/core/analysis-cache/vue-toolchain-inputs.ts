import type { VueProjectSemanticIdentity } from '#checkers';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AnalysisSnapshot } from './contracts';
import { inputStat } from './input-state';
import type { AnalysisInputs } from './inputs';
import { QueryTrace } from './query-trace';
export function observeVueToolFile(file: string, trace: QueryTrace): void {
  const dependency = trace.inputs.memoizeObservation(`vue-tool:${file}`, () => {
    const before = inputStat(file);
    return before === undefined
      ? trace.inputs.observe(file, 'bytes')
      : trace.inputs.observeBytes({
          path: file,
          bytes: readFileSync(file),
          beforeMtime: before.mtimeMs,
        });
  });
  trace.dependencies.set(dependency.inputId, dependency);
  trace.add(file, 'binding');
}

function observeModule(
  module: NodeJS.Module | undefined,
  trace: QueryTrace,
  seen: Set<string>,
): void {
  if (module === undefined) return;
  observeLoadedModule(module, trace, seen);
}
function observeLoadedModule(
  module: NodeJS.Module,
  trace: QueryTrace,
  seen: Set<string>,
): void {
  if (seen.has(module.filename)) return;
  seen.add(module.filename);
  observeVueToolFile(module.filename, trace);
  for (const child of module.children) observeModule(child, trace, seen);
}

export function observeVueTools(
  identity: VueProjectSemanticIdentity,
  trace: QueryTrace,
): void {
  const resolver = createRequire(identity.toolchain.paths.vueTsc);
  const seen = new Set<string>();
  for (const manifest of Object.values(identity.toolchain.paths)) {
    observeVueToolFile(manifest, trace);
  }
  for (const name of [
    'typescript',
    '@vue/language-core',
    '@volar/typescript',
  ]) {
    const entry = resolver.resolve(name);
    observeVueToolFile(entry, trace);
    observeModule(resolver.cache[entry], trace, seen);
  }
}

export function observePreviousVueBytes(
  state: AnalysisSnapshot,
  inputs: AnalysisInputs,
): void {
  const trace = new QueryTrace(inputs);
  const ids = new Set(
    Object.values(state.vueContexts).flatMap((record) =>
      record.dependencies.map((input) => input.inputId),
    ),
  );
  for (const id of ids) observePreviousInput(state.inputs[id], trace);
}
function observePreviousInput(
  input: AnalysisSnapshot['inputs'][string] | undefined,
  trace: QueryTrace,
): void {
  if (input?.kind === 'bytes') observeVueToolFile(input.path, trace);
}
