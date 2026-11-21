import { compareCodeUnits } from '#utils/collections';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { readFile } from 'node:fs/promises';
import path from 'pathe';
import {
  createLiminaArtifactNamespace,
  type LiminaArtifactNamespace,
} from '../../domain/artifacts/namespace';
import { createRevisionedArtifactPlan } from '../../domain/artifacts/plan';
import { removeStaleGeneratedFiles } from './artifact-ledger';
import { writeGeneratedContent, writeGeneratedJson } from './artifact-writer';
import type { GeneratedTsconfigGraphManifest } from './manifest-types';
import { generatedGraphManifestVersion } from './manifest-version';
import {
  materializationLedgerRelativePath,
  materializationMarkerRelativePath,
  readMaterializationStateSnapshot,
} from './materialization-state';
import type { GeneratedGraphPreparationState } from './prepare-state';
import { svelteCheckConfigPath } from './svelte-check-config';
import type {
  GeneratedGraphWriteContext,
  PreparedTsconfigGraph,
} from './types';

export async function planScopedCheckArtifacts(
  state: Pick<
    GeneratedGraphPreparationState,
    'purpose' | 'writeContext' | 'svelteConsumerView'
  >,
  root: LiminaArtifactNamespace,
): Promise<NonNullable<PreparedTsconfigGraph['auxiliaryArtifacts']>> {
  const result: NonNullable<PreparedTsconfigGraph['auxiliaryArtifacts']> = [];
  const byRoot = Map.groupBy(
    [...(state.svelteConsumerView?.checkFiles ?? [])],
    (file) => {
      const checkDirectory = path.dirname(file);
      return normalizeAbsolutePath(path.dirname(path.dirname(checkDirectory)));
    },
  );
  // The complete manifest also locates namespaces of no-longer-selected
  // consumers. Only their own authenticated ledgers authorize deletion.
  if (state.purpose === 'complete') {
    let previous: Partial<GeneratedTsconfigGraphManifest> | undefined;
    try {
      previous = JSON.parse(
        await readFile(path.join(root.rootDir, 'manifest.json'), 'utf8'),
      ) as Partial<GeneratedTsconfigGraphManifest>;
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    if (
      previous?.version === generatedGraphManifestVersion &&
      previous.generatedBy === 'limina'
    ) {
      const previousTargets = previous.targets?.framework ?? [];
      for (const target of previousTargets) {
        if (target.executionConfig === undefined) continue;
        const source = normalizeAbsolutePath(
          path.resolve(state.writeContext.rootDir, target.config),
        );
        const check = normalizeAbsolutePath(
          path.resolve(state.writeContext.rootDir, target.executionConfig),
        );
        if (
          !isPathInsideDirectory(source, state.writeContext.rootDir) ||
          check !== svelteCheckConfigPath(source)
        )
          throw new Error(
            `Invalid previous check namespace mapping: ${target.executionConfig}`,
          );
        const directory = path.dirname(source);
        if (
          byRoot.has(directory) ||
          path.join(directory, '.limina') === root.rootDir ||
          !(await hasScopedState(directory))
        )
          continue;
        byRoot.set(directory, []);
      }
    }
  }
  for (const [directory, files] of byRoot) {
    if (path.join(directory, '.limina') === root.rootDir) continue;
    const namespace = createLiminaArtifactNamespace({
      rootDir: directory,
      generation: root.generation,
    });
    const selected = new Set(files);
    const changes = state.writeContext.changes.filter(
      (change) =>
        change.status !== 'delete' && selected.has(change.artifact.path),
    );
    state.writeContext.changes = state.writeContext.changes.filter(
      (change) =>
        change.status === 'delete' || !selected.has(change.artifact.path),
    );
    for (const file of files) state.writeContext.expectedFiles.delete(file);
    const makePlan = (generatedFiles: Map<string, string>) =>
      scopedPlan(namespace, {
        rootDir: directory,
        files: generatedFiles,
        changes: [...changes],
        changed: false,
        expectedFiles: new Set(selected),
      });
    const plan = await makePlan(state.writeContext.files);
    result.push({
      namespace,
      plan,
      retiring: selected.size === 0,
      replan: async () => {
        const current = await makePlan(new Map());
        if (
          current.desiredRevision !== plan.desiredRevision ||
          (current.baseRevision !== plan.baseRevision &&
            current.baseRevision !== plan.desiredRevision)
        )
          throw new Error(
            'Scoped artifact revision changed outside the prepared graph. Retry with a fresh graph.',
          );
        return { namespace, plan: current };
      },
    });
  }
  return result;
}

async function hasScopedState(directory: string): Promise<boolean> {
  for (const file of [
    materializationLedgerRelativePath,
    materializationMarkerRelativePath,
  ]) {
    try {
      await readFile(path.join(directory, '.limina', file));
      return true;
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
  }
  return false;
}

async function scopedPlan(
  namespace: LiminaArtifactNamespace,
  local: GeneratedGraphWriteContext,
) {
  const base = await readMaterializationStateSnapshot(namespace);
  const previous = base.ownedPaths.map((file) =>
    normalizeAbsolutePath(path.join(namespace.rootDir, file)),
  );
  const ledger = normalizeAbsolutePath(
    path.join(namespace.rootDir, materializationLedgerRelativePath),
  );
  local.expectedFiles.add(ledger);
  for (const file of previous) {
    if (
      local.expectedFiles.has(file) ||
      file.startsWith(`${namespace.rootDir}/check/`)
    )
      continue;
    try {
      await writeGeneratedContent({
        context: local,
        filePath: file,
        content: await readFile(file, 'utf8'),
      });
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
  }
  await removeStaleGeneratedFiles({
    context: local,
    previousOwnedPaths: previous,
  });
  await writeGeneratedJson({
    context: local,
    filePath: ledger,
    value: {
      version: generatedGraphManifestVersion,
      generatedBy: 'limina',
      ownedArtifacts: [...local.expectedFiles]
        .map((file) => path.relative(namespace.rootDir, file))
        .sort(compareCodeUnits),
    },
  });
  return createRevisionedArtifactPlan(namespace, local.changes, {
    baseOwnedPaths: previous,
    baseRevision: base.revision,
    ownedPaths: [...local.expectedFiles],
  });
}
