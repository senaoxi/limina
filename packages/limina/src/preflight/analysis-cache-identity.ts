import type { ResolvedLiminaConfig } from '#config/runner';
import { resolveGovernanceRoot } from '#utils/workspace-root';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'pathe';
import ts from 'typescript';
import { getConfigInputs } from '../config/input-observation';
import { ANALYSIS_ADAPTER } from '../core/analysis-cache/contracts';
import { analysisHash } from '../core/analysis-cache/identity';
import { analysisToolIdentity } from './analysis-cache-tools';

export function readConfigInput(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function configInputs(
  config: ResolvedLiminaConfig,
): Map<string, string | null> {
  const inputs = new Map<string, string | null>(getConfigInputs(config));
  for (const file of [
    config.configPath,
    config.governanceRoot.manifestPath,
    path.join(config.rootDir, 'pnpm-workspace.yaml'),
  ]) {
    if (!inputs.has(file)) inputs.set(file, readConfigInput(file));
  }
  return inputs;
}

function toolVersion(configPath: string, name: string): string | null {
  try {
    return createRequire(configPath)(`${name}/package.json`).version;
  } catch {
    return null;
  }
}

export function analysisCacheIdentity(
  config: ResolvedLiminaConfig,
  tools: unknown = analysisToolIdentity(),
): string {
  return analysisHash({
    implementation: ANALYSIS_ADAPTER,
    executables: tools,
    typescript: ts.version,
    tsgo: toolVersion(config.configPath, '@typescript/native-preview'),
    resolver: toolVersion(config.configPath, 'oxc-resolver'),
    host: [
      process.platform,
      process.arch,
      process.version,
      ts.sys.useCaseSensitiveFileNames,
    ],
    config: config.configPath,
    root: config.rootDir,
    governance: [
      config.governanceRoot.kind,
      config.governanceRoot.manifestPath,
    ],
  });
}

export function assertGovernanceBinding(config: ResolvedLiminaConfig): void {
  const current = resolveGovernanceRoot(config.configPath);
  if (analysisHash(current) !== analysisHash(config.governanceRoot))
    throw new Error(
      'Limina governance root binding changed during execution. Run the command again to load the new configuration.',
    );
}
