import type { ResolvedLiminaConfig } from 'limina/internal/migration';
import {
  capabilityDiscoveryExtensions,
  collectReferencePathInfosFromConfigObject,
  isLiminaSolutionConfig,
  isTypeScriptSolutionConfig,
  normalizeAbsolutePath,
  parseCheckerProjectConfigForContext,
  readJsonConfig,
} from 'limina/internal/migration';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { MigrationTarget } from './types';

export async function readMigrationTarget(options: {
  config: ResolvedLiminaConfig;
  configPath: string;
  planningVirtualFiles: Map<string, string>;
}): Promise<MigrationTarget> {
  const configPath = normalizeAbsolutePath(options.configPath);
  const originalBytes = await originalTargetBytes(
    configPath,
    options.planningVirtualFiles,
  );
  const originalContent = originalBytes.toString('utf8');
  options.planningVirtualFiles.set(configPath, originalContent);
  const configObject = readJsonConfig(
    options.config,
    configPath,
    options.planningVirtualFiles,
  );
  // Invalid native entries are inventoried separately, not allowed to prevent
  // parsing source semantics that do not depend on these entries.
  const parsingObject = { ...configObject };
  if (Object.hasOwn(configObject, 'references'))
    parsingObject.references = collectReferencePathInfosFromConfigObject(
      options.config.rootDir,
      configPath,
      configObject,
    ).references.map((reference) => ({ path: reference.rawPath }));
  const parseFiles = new Map(options.planningVirtualFiles);
  parseFiles.set(configPath, JSON.stringify(parsingObject));
  const parsed = parseCheckerProjectConfigForContext({
    allowNoInputDiagnostics: true,
    configPath,
    context: {
      checkerPresets: ['tsc'],
      extensions: capabilityDiscoveryExtensions,
    },
    projectRootDir: options.config.rootDir,
    virtualFiles: parseFiles,
  });
  await captureInheritedInputs(
    options.planningVirtualFiles,
    parsed.configClosure,
  );
  return {
    configObject,
    configPath,
    effectiveConfig: {
      fileNames: parsed.fileNames,
      options: parsed.options,
    },
    isLiminaSolution: isLiminaSolutionConfig({
      configObject,
      configPath,
      fileNames: parsed.fileNames,
    }),
    isTypeScriptSolution: isTypeScriptSolutionConfig({
      configObject,
      configPath,
      fileNames: parsed.fileNames,
    }),
    originalBytes,
    originalContent,
  };
}

async function captureInheritedInputs(
  snapshot: Map<string, string>,
  closure: readonly { filePath: string; contentHash: string }[],
): Promise<void> {
  for (const entry of closure) {
    if (!snapshot.has(entry.filePath))
      await captureInheritedInput(snapshot, entry);
  }
}
async function captureInheritedInput(
  snapshot: Map<string, string>,
  entry: { filePath: string; contentHash: string },
): Promise<void> {
  const content = await readFile(entry.filePath, 'utf8');
  if (createHash('sha256').update(content).digest('hex') !== entry.contentHash)
    throw new Error(
      `Migration config snapshot changed during parsing: ${entry.filePath}`,
    );
  snapshot.set(entry.filePath, content);
}
async function originalTargetBytes(
  file: string,
  snapshot: ReadonlyMap<string, string>,
): Promise<Buffer> {
  const cached = snapshot.get(file);
  return cached === undefined ? readFile(file) : Buffer.from(cached);
}
