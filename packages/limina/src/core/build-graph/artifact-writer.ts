import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type {
  ArtifactKind,
  GeneratedArtifact,
} from '../../domain/artifacts/plan';
import { generatedManifestPath } from './generated/paths';
import { stringifyJson } from './problems';
import type { GeneratedGraphWriteContext } from './types';

function getGeneratedArtifactKind(filePath: string): ArtifactKind {
  if (filePath.endsWith(generatedManifestPath)) {
    return 'generated-manifest';
  }
  return filePath.includes('/knip/') ? 'tool-config' : 'generated-config';
}

function createGeneratedArtifact(
  filePath: string,
  content: string,
): GeneratedArtifact {
  return {
    content,
    kind: getGeneratedArtifactKind(filePath),
    origin: { domain: 'declaration-build' },
    path: filePath,
  };
}

async function readExistingContent(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) {
    return null;
  }
  return readFile(filePath, 'utf8');
}

async function getArtifactWriteStatus(options: {
  content: string;
  filePath: string;
}): Promise<'create' | 'unchanged' | 'update'> {
  const previousContent = await readExistingContent(options.filePath);
  if (previousContent === options.content) {
    return 'unchanged';
  }
  return previousContent === null ? 'create' : 'update';
}

export async function writeGeneratedJson(options: {
  context: GeneratedGraphWriteContext;
  filePath: string;
  value: unknown;
}): Promise<void> {
  const content = stringifyJson(options.value);
  const artifact = createGeneratedArtifact(options.filePath, content);
  options.context.expectedFiles.add(options.filePath);
  options.context.files.set(options.filePath, content);
  const status = await getArtifactWriteStatus({
    content,
    filePath: options.filePath,
  });
  options.context.changes.push({ artifact, status });
  if (status !== 'unchanged') {
    options.context.changed = true;
  }
}
