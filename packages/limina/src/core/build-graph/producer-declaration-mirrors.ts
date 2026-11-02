import { compareCodeUnits } from '#utils/collections';
import { readFile } from 'node:fs/promises';
import path from 'pathe';
import type { LiminaArtifactNamespace } from '../../domain/artifacts/namespace';
import { createRevisionedArtifactPlan } from '../../domain/artifacts/plan';
import { removeStaleGeneratedFiles } from './artifact-ledger';
import { writeGeneratedContent, writeGeneratedJson } from './artifact-writer';
import { generatedGraphManifestVersion } from './manifest-version';
import {
  materializationLedgerRelativePath,
  readMaterializationStateSnapshot,
} from './materialization-state';
import {
  assertProducerBuildReceipt,
  type ProducerBuildReceipt,
} from './producer-receipt';
import { createSvelteDeclarationBindings } from './svelte-consumer-view';
import type { GeneratedGraphWriteContext } from './types';

/**
Declaration publication belongs to the producer phase, before consumer reads.
*/
export async function prepareProducerDeclarationMirrors(
  receipt: ProducerBuildReceipt,
  namespace: LiminaArtifactNamespace,
  projectRootDirectory: string,
): Promise<ReturnType<typeof createRevisionedArtifactPlan>> {
  assertProducerBuildReceipt(receipt);
  const context: GeneratedGraphWriteContext = {
    rootDir: projectRootDirectory,
    changed: false,
    changes: [],
    files: new Map(),
    expectedFiles: new Set(),
  };
  const bindings = createSvelteDeclarationBindings(
    receipt,
    projectRootDirectory,
  );
  const base = await readMaterializationStateSnapshot(namespace);
  const previous = base.ownedPaths.map((file) =>
    path.join(namespace.rootDir, file),
  );
  const ledger = path.join(
    namespace.rootDir,
    materializationLedgerRelativePath,
  );
  context.expectedFiles.add(ledger);
  for (const [filePath, binding] of bindings)
    await writeGeneratedContent({
      context,
      filePath,
      content: binding.content,
    });
  for (const filePath of previous) {
    if (
      context.expectedFiles.has(filePath) ||
      filePath.startsWith(`${namespace.rootDir}/declarations/svelte/`)
    )
      continue;
    try {
      await writeGeneratedContent({
        context,
        filePath,
        content: await readFile(filePath, 'utf8'),
      });
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
  }
  await removeStaleGeneratedFiles({ context, previousOwnedPaths: previous });
  await writeGeneratedJson({
    context,
    filePath: ledger,
    value: {
      version: generatedGraphManifestVersion,
      generatedBy: 'limina',
      ownedArtifacts: [...context.expectedFiles]
        .map((file) => path.relative(namespace.rootDir, file))
        .sort(compareCodeUnits),
    },
  });
  const plan = createRevisionedArtifactPlan(namespace, context.changes, {
    baseOwnedPaths: previous,
    baseRevision: base.revision,
    ownedPaths: [...context.expectedFiles],
  });
  return plan;
}
