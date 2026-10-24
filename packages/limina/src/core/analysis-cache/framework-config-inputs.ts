import { observeAnalysisRead, readAnalysisInput } from '#utils/analysis-input';
import { normalizeAbsolutePath } from '#utils/path';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { observeConfigLoad } from '../../config/input-observation';
import { loadConfigModule } from '../../config/loader-import';
import type { GovernedSourceUnit } from '../build-graph/types';
import { observedCompilerSystem } from '../typescript-semantic/observed-resolution-host';
import type { EpochInputs } from './epoch-inputs';

type LoadedConfig = Awaited<ReturnType<typeof observeConfigLoad>>;
export type FrameworkConfigLoads = Map<string, Promise<LoadedConfig>>;

async function loadConfig(file: string): Promise<LoadedConfig> {
  const loaded = await observeConfigLoad(
    file,
    (url) =>
      loadConfigModule('native', { entryURL: url, evaluate: async () => ({}) }),
    { namespace: randomUUID() },
  );
  // Live invocation evidence retains the original bytes and resolution bindings.
  // Serializable loader source/format receipts are a separate cache requirement.
  if (loaded.evidence.unknown.size > 0)
    throw new Error(
      `Framework configuration inputs are incomplete: ${file} (${[...loaded.evidence.unknown].join(', ')}).`,
    );
  return loaded;
}
function observeConfig(file: string, loaded: LoadedConfig): void {
  for (const input of loaded.inputs.keys())
    readAnalysisInput(
      input,
      () => ts.sys.readFile(input),
      'typescript-content',
    );
  loaded.evidence.assertStable();
  observeAnalysisRead({
    path: file,
    key: JSON.stringify(['framework-configuration', file]),
    value: true,
    read: () => {
      loaded.evidence.assertStable();
      return true;
    },
  });
}
function nearestConfig(directory: string): string | undefined {
  for (
    let current = directory;
    current !== path.dirname(current);
    current = path.dirname(current)
  ) {
    const found = ['js', 'cjs', 'mjs']
      .map((extension) => path.join(current, `svelte.config.${extension}`))
      .find((file) =>
        readAnalysisInput(file, () => ts.sys.fileExists(file), 'file'),
      );
    if (found !== undefined) return found;
  }
  return undefined;
}
function configFiles(
  source: GovernedSourceUnit,
  inputs: EpochInputs,
): Set<string> {
  const host = observedCompilerSystem(ts, source.configPath);
  const directory = path.dirname(source.configPath);
  // svelte-check eagerly loads nested configuration modules for the selected tsconfig.
  const files = new Set(
    host.readDirectory(
      directory,
      ['.js', '.cjs', '.mjs'],
      ['**/node_modules/**', '**/.*/**'],
      ['**/svelte.config.*'],
    ),
  );
  const directories = new Set([
    directory,
    ...[...inputs.paths]
      .filter((file) => file.endsWith('.svelte'))
      .map((file) => path.dirname(file)),
  ]);
  for (const current of directories) {
    const file = nearestConfig(current);
    if (file !== undefined) files.add(file);
  }
  return new Set([...files].map(normalizeAbsolutePath));
}
/**
Svelte's executable configuration belongs only to targets which consume it.
*/
export async function collectFrameworkConfigInputs(input: {
  source: GovernedSourceUnit;
  inputs: EpochInputs;
  loads: FrameworkConfigLoads;
}): Promise<void> {
  if (
    input.source.frameworkCapabilities.every(
      (capability) => capability.family !== 'svelte',
    )
  )
    return;
  await input.inputs.collect(async () => {
    for (const file of configFiles(input.source, input.inputs)) {
      let loaded = input.loads.get(file);
      if (loaded === undefined) {
        loaded = loadConfig(file);
        input.loads.set(file, loaded);
      }
      observeConfig(file, await loaded);
    }
  });
}
