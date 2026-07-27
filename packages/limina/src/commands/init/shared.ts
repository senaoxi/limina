import type { ResolvedLiminaConfig } from '#config/runner';
import { toRelativePath } from '#utils/path';
import path from 'pathe';
import type { InitMutationContext } from './mutation';
import { writeInitFile } from './mutation';

export const pnpmWorkspaceFileName = 'pnpm-workspace.yaml';
export const liminaConfigFileName = 'limina.config.mts';
export const liminaBuildScriptName = 'limina:build';
export const liminaBuildScriptValue = 'limina checker build';
export const liminaSkillInstallCommand = [
  'npx',
  '--yes',
  'skills',
  'add',
  'senaoxi/docs-islands',
  '--skill',
  'limina',
] as const;

export function createInitConfig(rootDir: string): ResolvedLiminaConfig {
  return {
    configPath: path.join(rootDir, liminaConfigFileName),
    rootDir,
  };
}

export function formatConfigPath(rootDir: string, configPath: string): string {
  return toRelativePath(rootDir, configPath);
}

export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function createLiminaConfigContent(): string {
  return `import { defineConfig } from 'limina';

export default defineConfig({
  config: {
    checkers: {
      mode: 'auto',
      exclude: [],
    },
  },
});
`;
}

export async function writeTextFile(options: {
  content: string;
  filePath: string;
  mutationContext: InitMutationContext;
  writtenFiles: string[];
}): Promise<void> {
  await writeInitFile({
    content: options.content,
    context: options.mutationContext,
    filePath: options.filePath,
  });
  options.writtenFiles.push(options.filePath);
}

export function formatCommand(command: readonly string[]): string {
  return command.join(' ');
}
