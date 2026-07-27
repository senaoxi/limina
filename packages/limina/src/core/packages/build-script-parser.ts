import { parseBuildArguments } from './build-script-arguments';
import { createBuildScriptDiagnostic } from './build-script-diagnostic';
import {
  getLiminaBuildArgumentOffset,
  tokenizeStaticCommand,
} from './build-script-tokenizer';
import type {
  PackageBuildScript,
  PackageBuildScriptDiagnostic,
  PackageBuildScriptSource,
} from './build-script-types';

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

  if (argumentOffset === null) {
    return createBuildScriptDiagnostic(
      source,
      'Limina only recognizes direct limina build, pnpm limina build, and pnpm exec limina build package scripts.',
    );
  }

  return { argumentOffset, tokens };
}

function prepareCommand(
  source: PackageBuildScriptSource,
): PreparedCommand | PackageBuildScriptDiagnostic | null {
  if (!hasLiminaBuildIntent(source.command)) {
    return null;
  }

  if (hasDynamicShellSyntax(source.command)) {
    return createBuildScriptDiagnostic(
      source,
      'Limina only derives Knip source configs from static limina build scripts without shell control operators or dynamic expansion.',
    );
  }

  return tokenizePreparedCommand(source);
}

function isDiagnostic(
  value: PreparedCommand | PackageBuildScriptDiagnostic,
): value is PackageBuildScriptDiagnostic {
  return 'reason' in value;
}

export function parsePackageBuildScript(
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
