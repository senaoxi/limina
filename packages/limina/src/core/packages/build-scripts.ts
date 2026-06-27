import type { BuildCheckerPreset, ResolvedLiminaConfig } from '#config/runner';
import type { WorkspacePackage } from '#core/workspace/actions';
import { isNamedWorkspacePackage } from '#core/workspace/actions';
import { normalizeAbsolutePath, toRelativePath } from '#utils/path';
import path from 'pathe';

export interface PackageBuildScript {
  checker?: BuildCheckerPreset;
  command: string;
  configPath: string;
  raw: boolean;
  name: string;
  packageJsonPath: string;
  packageName: string;
}

export interface PackageBuildScriptDiagnostic {
  command: string;
  packageJsonPath: string;
  packageName: string;
  reason: string;
  scriptName: string;
}

export interface PackageBuildScriptCollection {
  diagnostics: PackageBuildScriptDiagnostic[];
  scripts: PackageBuildScript[];
}

const supportedBuildCheckers = new Set(['tsc', 'vue-tsc', 'tsgo']);

function hasLiminaBuildIntent(command: string): boolean {
  return /\blimina\s+build\b/u.test(command);
}

function hasShellControlOperator(command: string): boolean {
  return /(?:^|\s)(?:&&|\|\||[;|<>])(?:\s|$)/u.test(command);
}

function tokenizeStaticCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const element of command) {
    const char = element!;

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function getLiminaBuildArgumentOffset(tokens: string[]): number | null {
  if (tokens[0] === 'limina' && tokens[1] === 'build') {
    return 2;
  }

  if (tokens[0] === 'pnpm' && tokens[1] === 'limina' && tokens[2] === 'build') {
    return 3;
  }

  if (
    tokens[0] === 'pnpm' &&
    tokens[1] === 'exec' &&
    tokens[2] === 'limina' &&
    tokens[3] === 'build'
  ) {
    return 4;
  }

  return null;
}

function parseChecker(value: string | undefined): BuildCheckerPreset | null {
  return value && supportedBuildCheckers.has(value)
    ? (value as BuildCheckerPreset)
    : null;
}

function createDiagnostic(options: {
  command: string;
  packageJsonPath: string;
  packageName: string;
  reason: string;
  scriptName: string;
}): PackageBuildScriptDiagnostic {
  return options;
}

function parsePackageBuildScript(options: {
  command: string;
  packageJsonPath: string;
  packageName: string;
  packageDirectory: string;
  scriptName: string;
}): PackageBuildScript | PackageBuildScriptDiagnostic | null {
  if (!hasLiminaBuildIntent(options.command)) {
    return null;
  }

  if (
    hasShellControlOperator(options.command) ||
    /[$`]/u.test(options.command)
  ) {
    return createDiagnostic({
      command: options.command,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
      reason:
        'Limina only derives Knip source configs from static limina build scripts without shell control operators or dynamic expansion.',
      scriptName: options.scriptName,
    });
  }

  const tokens = tokenizeStaticCommand(options.command);

  if (!tokens) {
    return createDiagnostic({
      command: options.command,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
      reason: 'Limina could not statically tokenize this package script.',
      scriptName: options.scriptName,
    });
  }

  const argumentOffset = getLiminaBuildArgumentOffset(tokens);

  if (argumentOffset === null) {
    return createDiagnostic({
      command: options.command,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
      reason:
        'Limina only recognizes direct limina build, pnpm limina build, and pnpm exec limina build package scripts.',
      scriptName: options.scriptName,
    });
  }

  let checker: BuildCheckerPreset | undefined;
  let configPath: string | undefined;
  let raw = false;

  for (let index = argumentOffset; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (token === '-w' || token === '--watch') {
      continue;
    }

    if (token === '--raw') {
      raw = true;
      continue;
    }

    if (token === '--checker' || token.startsWith('--checker=')) {
      return createDiagnostic({
        command: options.command,
        packageJsonPath: options.packageJsonPath,
        packageName: options.packageName,
        reason: 'Unknown option: --checker. Use --preset instead.',
        scriptName: options.scriptName,
      });
    }

    if (token === '--preset') {
      const parsedChecker = parseChecker(tokens[index + 1]);

      if (!parsedChecker) {
        return createDiagnostic({
          command: options.command,
          packageJsonPath: options.packageJsonPath,
          packageName: options.packageName,
          reason: '--preset must be one of: tsc, vue-tsc, tsgo.',
          scriptName: options.scriptName,
        });
      }

      checker = parsedChecker;
      index += 1;
      continue;
    }

    if (token.startsWith('--preset=')) {
      const parsedChecker = parseChecker(token.slice('--preset='.length));

      if (!parsedChecker) {
        return createDiagnostic({
          command: options.command,
          packageJsonPath: options.packageJsonPath,
          packageName: options.packageName,
          reason: '--preset must be one of: tsc, vue-tsc, tsgo.',
          scriptName: options.scriptName,
        });
      }

      checker = parsedChecker;
      continue;
    }

    if (token.startsWith('-')) {
      return createDiagnostic({
        command: options.command,
        packageJsonPath: options.packageJsonPath,
        packageName: options.packageName,
        reason:
          'Limina build script analysis only supports --raw, --preset, -w/--watch, plus one literal config argument.',
        scriptName: options.scriptName,
      });
    }

    if (configPath) {
      return createDiagnostic({
        command: options.command,
        packageJsonPath: options.packageJsonPath,
        packageName: options.packageName,
        reason: 'Limina build script analysis found multiple config arguments.',
        scriptName: options.scriptName,
      });
    }

    configPath = token;
  }

  if (!configPath) {
    return createDiagnostic({
      command: options.command,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
      reason: 'Limina build script analysis requires a config argument.',
      scriptName: options.scriptName,
    });
  }

  if (raw && !checker) {
    return createDiagnostic({
      command: options.command,
      packageJsonPath: options.packageJsonPath,
      packageName: options.packageName,
      reason: 'limina build --raw package scripts require --preset.',
      scriptName: options.scriptName,
    });
  }

  return {
    ...(checker ? { checker } : {}),
    command: options.command,
    configPath: normalizeAbsolutePath(
      path.resolve(options.packageDirectory, configPath),
    ),
    raw,
    name: options.scriptName,
    packageJsonPath: options.packageJsonPath,
    packageName: options.packageName,
  };
}

export function collectPackageBuildScripts(options: {
  config: ResolvedLiminaConfig;
  workspacePackages: WorkspacePackage[];
}): PackageBuildScriptCollection {
  const diagnostics: PackageBuildScriptDiagnostic[] = [];
  const scripts: PackageBuildScript[] = [];

  for (const workspacePackage of options.workspacePackages) {
    if (!isNamedWorkspacePackage(workspacePackage)) {
      continue;
    }

    const packageJsonPath = normalizeAbsolutePath(
      path.join(workspacePackage.directory, 'package.json'),
    );
    const scriptEntries = Object.entries(
      workspacePackage.manifest.scripts ?? {},
    )
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      )
      .sort(([left], [right]) => left.localeCompare(right));

    for (const [scriptName, command] of scriptEntries) {
      const parsed = parsePackageBuildScript({
        command,
        packageDirectory: workspacePackage.directory,
        packageJsonPath,
        packageName: workspacePackage.name,
        scriptName,
      });

      if (!parsed) {
        continue;
      }

      if ('reason' in parsed) {
        diagnostics.push(parsed);
      } else {
        scripts.push(parsed);
      }
    }
  }

  diagnostics.sort(
    (left, right) =>
      left.packageJsonPath.localeCompare(right.packageJsonPath) ||
      left.scriptName.localeCompare(right.scriptName),
  );
  scripts.sort(
    (left, right) =>
      toRelativePath(
        options.config.rootDir,
        left.packageJsonPath,
      ).localeCompare(
        toRelativePath(options.config.rootDir, right.packageJsonPath),
      ) || left.name.localeCompare(right.name),
  );

  return {
    diagnostics,
    scripts,
  };
}
