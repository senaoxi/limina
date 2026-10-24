import type { ResolvedLiminaInputs } from '#config/runner';
import {
  isOrdinarySourceTypecheckConfigPath,
  readJsonConfig,
} from '#core/tsconfig/actions';
import { normalizeAbsolutePath } from '#utils/path';
import { isPlainRecord } from '#utils/values';
import path from 'pathe';
import { isDeclarationFile } from '../import-graph/declaration-classifier';

export interface DeclarationContextChoice {
  file: string;
  config: string;
}

export function readDeclarationContextChoices(
  config: ResolvedLiminaInputs,
  sourceConfig: string,
): { choices: DeclarationContextChoice[]; problems: string[] } {
  const raw = readJsonConfig(config, sourceConfig).liminaOptions;
  const value = isPlainRecord(raw) ? raw.declarationContexts : undefined;
  const choices: DeclarationContextChoice[] = [];
  const problems: string[] = [];
  if (value === undefined) return { choices, problems };
  if (!Array.isArray(value))
    return {
      choices,
      problems: [
        `${sourceConfig}: liminaOptions.declarationContexts must be an array.`,
      ],
    };
  for (const entry of value) {
    const choice = parseChoice(entry, sourceConfig, config.rootDir);
    if (typeof choice === 'string') problems.push(choice);
    else choices.push(choice);
  }
  return { choices, problems };
}

function isRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !path.isAbsolute(value) &&
    !/[*?[\]{}]/.test(value)
  );
}

function parseChoice(
  entry: unknown,
  sourceConfig: string,
  rootDirectory: string,
): DeclarationContextChoice | string {
  if (
    !isPlainRecord(entry) ||
    !isRelativePath(entry.file) ||
    !isRelativePath(entry.config)
  )
    return `${sourceConfig}: declarationContexts entries require relative file and config paths without globs.`;
  const base = path.dirname(sourceConfig);
  const file = normalizeAbsolutePath(path.resolve(base, entry.file));
  const config = normalizeAbsolutePath(path.resolve(base, entry.config));
  return !isDeclarationFile(file) ||
    !isOrdinarySourceTypecheckConfigPath(config, rootDirectory)
    ? `${sourceConfig}: declarationContexts must select a declaration and an ordinary source tsconfig.`
    : { file, config };
}
