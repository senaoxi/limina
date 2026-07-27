import { collectImportsFromFile } from '#core/import-graph/context';
import { shouldInferDeclarationReferenceFromImportRecord } from '../import-graph/declaration-reference-evidence';
import type {
  ReferenceImportContext,
  ReferenceImportOptions,
} from './reference-import-types';
import { addMappedReference } from './reference-recording';
import {
  createReferenceTarget,
  isValidReferenceTarget,
  resolveUsableProvider,
} from './reference-target-resolution';
import type { SourceProject } from './types';

export type { ReferenceImportContext } from './reference-import-types';

function processReferenceImport(options: ReferenceImportOptions): void {
  const provider = resolveUsableProvider(options);
  if (!provider) {
    return;
  }
  const target = createReferenceTarget({ base: options, provider });
  if (isValidReferenceTarget(options.project.configPath, target)) {
    addMappedReference({ base: options, target });
  }
}

function processProjectFileImports(options: {
  context: ReferenceImportContext;
  fileName: string;
  project: SourceProject;
}): void {
  const imports = collectImportsFromFile(
    options.fileName,
    options.context.config.rootDir,
    options.context.importAnalysis,
  );
  for (const importRecord of imports) {
    if (shouldInferDeclarationReferenceFromImportRecord(importRecord)) {
      processReferenceImport({ ...options, importRecord });
    }
  }
}

export function processProjectReferenceImports(options: {
  context: ReferenceImportContext;
  project: SourceProject;
}): void {
  for (const fileName of options.project.ownedFileNames) {
    processProjectFileImports({ ...options, fileName });
  }
}
