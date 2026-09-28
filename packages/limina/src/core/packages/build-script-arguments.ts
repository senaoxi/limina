import type { BuildCheckerPreset } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { createBuildScriptDiagnostic } from './build-script-diagnostic';
import { parseBuildChecker } from './build-script-tokenizer';
import type {
  PackageBuildScript,
  PackageBuildScriptDiagnostic,
  PackageBuildScriptSource,
} from './build-script-types';

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
    ...(state.checker === undefined ? {} : { checker: state.checker }),
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

export function parseBuildArguments(options: {
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
