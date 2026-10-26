import type { BuildCheckerPreset, ResolvedLiminaInputs } from '#config/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';

export interface PackageBuildScript {
  checker?: BuildCheckerPreset;
  command: string;
  configPath: string;
  name: string;
  packageJsonPath: string;
  packageName?: string;
  raw: boolean;
}

export interface PackageBuildScriptDiagnostic {
  command: string;
  packageJsonPath: string;
  packageName?: string;
  reason: string;
  scriptName: string;
}

export interface PackageBuildScriptCollection {
  diagnostics: PackageBuildScriptDiagnostic[];
  scripts: PackageBuildScript[];
}

interface PackageBuildScriptSource {
  command: string;
  packageDirectory: string;
  packageJsonPath: string;
  packageName?: string;
  scriptName: string;
}

interface TokenizerState {
  current: string;
  quote: '"' | "'" | null;
  tokens: string[];
}

const supportedBuildCheckers = new Set(['tsc', 'vue-tsc', 'tsgo']);

function appendCurrentToken(state: TokenizerState): void {
  if (state.current.length === 0) {
    return;
  }

  state.tokens.push(state.current);
  state.current = '';
}

function handleQuotedCharacter(state: TokenizerState, character: string): void {
  if (character === state.quote) {
    state.quote = null;
    return;
  }

  state.current += character;
}

function isQuoteCharacter(character: string): character is '"' | "'" {
  return character === '"' || character === "'";
}

function handleUnquotedCharacter(
  state: TokenizerState,
  character: string,
): void {
  if (isQuoteCharacter(character)) {
    state.quote = character;
    return;
  }

  if (/\s/u.test(character)) {
    appendCurrentToken(state);
    return;
  }

  state.current += character;
}

function finalizeTokens(state: TokenizerState): string[] | null {
  if (state.quote !== null) {
    return null;
  }

  appendCurrentToken(state);
  return state.tokens;
}

function tokenizeStaticCommand(command: string): string[] | null {
  const state: TokenizerState = { current: '', quote: null, tokens: [] };

  for (const character of command) {
    if (state.quote === null) {
      handleUnquotedCharacter(state, character);
    } else {
      handleQuotedCharacter(state, character);
    }
  }

  return finalizeTokens(state);
}

interface CommandPrefix {
  argumentOffset: number;
  tokens: readonly string[];
}

const commandPrefixes: readonly CommandPrefix[] = [
  { argumentOffset: 2, tokens: ['limina', 'build'] },
  { argumentOffset: 3, tokens: ['pnpm', 'limina', 'build'] },
  { argumentOffset: 4, tokens: ['pnpm', 'exec', 'limina', 'build'] },
];

function isTokensStartWith(
  tokens: readonly string[],
  prefix: readonly string[],
): boolean {
  return prefix.every((token, index) => tokens[index] === token);
}

function getLiminaBuildArgumentOffset(
  tokens: readonly string[],
): number | null {
  const prefix = commandPrefixes.find((candidate) =>
    isTokensStartWith(tokens, candidate.tokens),
  );
  return prefix === undefined ? null : prefix.argumentOffset;
}

function parseBuildChecker(
  value: string | undefined,
): BuildCheckerPreset | null {
  return value !== undefined && supportedBuildCheckers.has(value)
    ? (value as BuildCheckerPreset)
    : null;
}

function createBuildScriptDiagnostic(
  source: PackageBuildScriptSource,
  reason: string,
): PackageBuildScriptDiagnostic {
  return {
    command: source.command,
    packageJsonPath: source.packageJsonPath,
    packageName: source.packageName,
    reason,
    scriptName: source.scriptName,
  };
}

interface ArgumentState {
  checker?: BuildCheckerPreset;
  configPath?: string;
  raw: boolean;
}

interface TokenContext {
  index: number;
  source: PackageBuildScriptSource;
  state: ArgumentState;
  token: string;
  tokens: readonly string[];
}

interface TokenResult {
  diagnostic?: PackageBuildScriptDiagnostic;
  nextIndex: number;
}

interface TokenHandler {
  handle(context: TokenContext): TokenResult;
  matches(token: string): boolean;
}

function unchangedResult(context: TokenContext): TokenResult {
  return { nextIndex: context.index };
}

const watchHandler: TokenHandler = {
  handle: unchangedResult,
  matches: (token) => token === '-w' || token === '--watch',
};

const rawHandler: TokenHandler = {
  handle(context) {
    context.state.raw = true;
    return unchangedResult(context);
  },
  matches: (token) => token === '--raw',
};

function applyChecker(
  context: TokenContext,
  value: string | undefined,
  nextIndex: number,
): TokenResult {
  const checker = parseBuildChecker(value);

  if (checker === null) {
    return {
      diagnostic: createBuildScriptDiagnostic(
        context.source,
        '--preset must be one of: tsc, vue-tsc, tsgo.',
      ),
      nextIndex,
    };
  }

  context.state.checker = checker;
  return { nextIndex };
}

const separatePresetHandler: TokenHandler = {
  handle(context) {
    return applyChecker(
      context,
      context.tokens[context.index + 1],
      context.index + 1,
    );
  },
  matches: (token) => token === '--preset',
};

const inlinePresetHandler: TokenHandler = {
  handle(context) {
    return applyChecker(
      context,
      context.token.slice('--preset='.length),
      context.index,
    );
  },
  matches: (token) => token.startsWith('--preset='),
};

const unsupportedFlagHandler: TokenHandler = {
  handle(context) {
    return {
      diagnostic: createBuildScriptDiagnostic(
        context.source,
        'Limina build script analysis only supports --raw, --preset, -w/--watch, plus one literal config argument.',
      ),
      nextIndex: context.index,
    };
  },
  matches: (token) => token.startsWith('-'),
};

const duplicateConfigHandler: TokenHandler = {
  handle(context) {
    return {
      diagnostic: createBuildScriptDiagnostic(
        context.source,
        'Limina build script analysis found multiple config arguments.',
      ),
      nextIndex: context.index,
    };
  },
  matches: () => false,
};

const configPathHandler: TokenHandler = {
  handle(context) {
    context.state.configPath = context.token;
    return unchangedResult(context);
  },
  matches: () => true,
};

const tokenHandlers: readonly TokenHandler[] = [
  watchHandler,
  rawHandler,
  separatePresetHandler,
  inlinePresetHandler,
  unsupportedFlagHandler,
];

function selectTokenHandler(context: TokenContext): TokenHandler {
  const matched = tokenHandlers.find((handler) =>
    handler.matches(context.token),
  );

  if (matched !== undefined) {
    return matched;
  }

  return context.state.configPath === undefined
    ? configPathHandler
    : duplicateConfigHandler;
}

function parseArguments(
  source: PackageBuildScriptSource,
  tokens: readonly string[],
  argumentOffset: number,
): ArgumentState | PackageBuildScriptDiagnostic {
  const state: ArgumentState = { raw: false };

  for (let index = argumentOffset; index < tokens.length; index += 1) {
    const context: TokenContext = {
      index,
      source,
      state,
      token: tokens[index]!,
      tokens,
    };
    const result = selectTokenHandler(context).handle(context);

    if (result.diagnostic !== undefined) {
      return result.diagnostic;
    }

    index = result.nextIndex;
  }

  return state;
}

function validateConfigPath(
  source: PackageBuildScriptSource,
  state: ArgumentState,
): PackageBuildScriptDiagnostic | null {
  return state.configPath === undefined
    ? createBuildScriptDiagnostic(
        source,
        'Limina build script analysis requires a config argument.',
      )
    : null;
}

function validateRawChecker(
  source: PackageBuildScriptSource,
  state: ArgumentState,
): PackageBuildScriptDiagnostic | null {
  return state.raw && state.checker === undefined
    ? createBuildScriptDiagnostic(
        source,
        'limina build --raw package scripts require --preset.',
      )
    : null;
}

function createBuildScript(
  source: PackageBuildScriptSource,
  state: ArgumentState,
): PackageBuildScript {
  return {
    ...(state.checker !== undefined && { checker: state.checker }),
    command: source.command,
    configPath: normalizeAbsolutePath(
      path.resolve(source.packageDirectory, state.configPath!),
    ),
    name: source.scriptName,
    packageJsonPath: source.packageJsonPath,
    packageName: source.packageName,
    raw: state.raw,
  };
}

function finalizeBuildScript(
  source: PackageBuildScriptSource,
  state: ArgumentState,
): PackageBuildScript | PackageBuildScriptDiagnostic {
  return (
    validateConfigPath(source, state) ??
    validateRawChecker(source, state) ??
    createBuildScript(source, state)
  );
}

function parseBuildArguments(options: {
  argumentOffset: number;
  source: PackageBuildScriptSource;
  tokens: readonly string[];
}): PackageBuildScript | PackageBuildScriptDiagnostic {
  const parsed = parseArguments(
    options.source,
    options.tokens,
    options.argumentOffset,
  );

  return 'reason' in parsed
    ? parsed
    : finalizeBuildScript(options.source, parsed);
}

type ParseResult = PackageBuildScript | PackageBuildScriptDiagnostic | null;

interface PreparedCommand {
  argumentOffset: number;
  tokens: readonly string[];
}

function hasLiminaBuildIntent(command: string): boolean {
  return /\blimina\s+build\b/u.test(command);
}

function hasDynamicShellSyntax(command: string): boolean {
  return (
    /(?:^|\s)(?:&&|\|\||[;|<>])(?:\s|$)/u.test(command) || /[$`]/u.test(command)
  );
}

function tokenizePreparedCommand(
  source: PackageBuildScriptSource,
): PreparedCommand | PackageBuildScriptDiagnostic {
  const tokens = tokenizeStaticCommand(source.command);

  if (tokens === null) {
    return createBuildScriptDiagnostic(
      source,
      'Limina could not statically tokenize this package script.',
    );
  }

  const argumentOffset = getLiminaBuildArgumentOffset(tokens);

  return argumentOffset === null
    ? createBuildScriptDiagnostic(
        source,
        'Limina only recognizes direct limina build, pnpm limina build, and pnpm exec limina build package scripts.',
      )
    : { argumentOffset, tokens };
}

function prepareCommand(
  source: PackageBuildScriptSource,
): PreparedCommand | PackageBuildScriptDiagnostic | null {
  if (!hasLiminaBuildIntent(source.command)) {
    return null;
  }

  return hasDynamicShellSyntax(source.command)
    ? createBuildScriptDiagnostic(
        source,
        'Limina only derives Knip source configs from static limina build scripts without shell control operators or dynamic expansion.',
      )
    : tokenizePreparedCommand(source);
}

function isDiagnostic(
  value: PreparedCommand | PackageBuildScriptDiagnostic,
): value is PackageBuildScriptDiagnostic {
  return 'reason' in value;
}

function parsePackageBuildScript(
  source: PackageBuildScriptSource,
): ParseResult {
  const prepared = prepareCommand(source);

  if (prepared === null) {
    return null;
  }

  return isDiagnostic(prepared)
    ? prepared
    : parseBuildArguments({
        argumentOffset: prepared.argumentOffset,
        source,
        tokens: prepared.tokens,
      });
}

function collectScriptEntries(
  workspacePackage: WorkspacePackage,
): [string, string][] {
  return Object.entries(workspacePackage.manifest.scripts ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .sort(([left], [right]) => left.localeCompare(right));
}

function createScriptSource(options: {
  command: string;
  packageJsonPath: string;
  scriptName: string;
  workspacePackage: WorkspacePackage;
}): PackageBuildScriptSource {
  return {
    command: options.command,
    packageDirectory: options.workspacePackage.directory,
    packageJsonPath: options.packageJsonPath,
    packageName: options.workspacePackage.name,
    scriptName: options.scriptName,
  };
}

function appendParsedScript(
  collection: PackageBuildScriptCollection,
  parsed: PackageBuildScript | PackageBuildScriptDiagnostic | null,
): void {
  if (parsed === null) {
    return;
  }

  if ('reason' in parsed) {
    collection.diagnostics.push(parsed);
    return;
  }

  collection.scripts.push(parsed);
}

function collectWorkspacePackageScripts(
  collection: PackageBuildScriptCollection,
  workspacePackage: WorkspacePackage,
): void {
  const packageJsonPath = normalizeAbsolutePath(
    path.join(workspacePackage.directory, 'package.json'),
  );

  for (const [scriptName, command] of collectScriptEntries(workspacePackage)) {
    appendParsedScript(
      collection,
      parsePackageBuildScript(
        createScriptSource({
          command,
          packageJsonPath,
          scriptName,
          workspacePackage,
        }),
      ),
    );
  }
}

function compareDiagnostics(
  left: PackageBuildScriptDiagnostic,
  right: PackageBuildScriptDiagnostic,
): number {
  return (
    left.packageJsonPath.localeCompare(right.packageJsonPath) ||
    left.scriptName.localeCompare(right.scriptName)
  );
}

function compareScripts(
  rootDirectory: string,
  left: PackageBuildScript,
  right: PackageBuildScript,
): number {
  const packageComparison = toRelativePath(
    rootDirectory,
    left.packageJsonPath,
  ).localeCompare(toRelativePath(rootDirectory, right.packageJsonPath));

  return packageComparison || left.name.localeCompare(right.name);
}

function sortCollection(
  config: ResolvedLiminaInputs,
  collection: PackageBuildScriptCollection,
): PackageBuildScriptCollection {
  collection.diagnostics.sort(compareDiagnostics);
  collection.scripts.sort((left, right) =>
    compareScripts(config.rootDir, left, right),
  );
  return collection;
}

export function collectPackageBuildScripts(options: {
  config: ResolvedLiminaInputs;
  workspacePackages: WorkspacePackage[];
}): PackageBuildScriptCollection {
  const collection: PackageBuildScriptCollection = {
    diagnostics: [],
    scripts: [],
  };

  for (const workspacePackage of options.workspacePackages) {
    collectWorkspacePackageScripts(collection, workspacePackage);
  }

  return sortCollection(options.config, collection);
}
