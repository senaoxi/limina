import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'pathe';

interface PnpApi {
  VERSIONS: { std: number };
  resolveToUnqualified(request: string, issuer: null): string;
}

export interface PnpRuntime {
  entry: string;
  esmLoader: string;
  data: string;
}

/**
Only the API provided by the running resolver can identify its preload.
*/
export function activePnpRuntime(): PnpRuntime | undefined {
  const version = process.versions.pnp;
  if (version === undefined) return undefined;
  const issuer = path.join(process.cwd(), 'package.json');
  const require = createRequire(issuer);
  try {
    const api: PnpApi = require('pnpapi');
    if (String(api.VERSIONS.std) !== version) return undefined;
    const entry = realpathSync.native(api.resolveToUnqualified('pnpapi', null));
    if (entry !== realpathSync.native(require.resolve('pnpapi')))
      return undefined;
    const directory = path.dirname(entry);
    return {
      entry,
      esmLoader: path.join(directory, '.pnp.loader.mjs'),
      data: path.join(directory, '.pnp.data.json'),
    };
  } catch {
    return undefined;
  }
}

function isRuntimeArgument(
  runtime: PnpRuntime,
  flag: string,
  value: string,
): boolean {
  const expected =
    flag === '--require' || flag === '-r' ? runtime.entry : runtime.esmLoader;
  try {
    return (
      realpathSync.native(
        value.startsWith('file:') ? fileURLToPath(value) : value,
      ) === realpathSync.native(expected)
    );
  } catch {
    return false;
  }
}

/**
Strip exactly the observed runtime hooks. Other Node startup hooks still need admission.
*/
export function withoutPnpHooks(
  arguments_: string[],
  runtime: PnpRuntime | undefined,
): string[] {
  if (runtime === undefined) return arguments_;
  const rest: string[] = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    const match =
      /^(--require|--experimental-loader|--loader)(?:=(.*))?$/u.exec(
        argument,
      ) ?? /^(-r)(.+)?$/u.exec(argument);
    const value = match?.[2] ?? arguments_[index + 1];
    if (match && value && isRuntimeArgument(runtime, match[1]!, value)) {
      if (match[2] === undefined) index++;
    } else rest.push(argument);
  }
  return rest;
}

/**
Node allows double-quoted option values, including escaped characters inside quotes.
*/
export function nodeOptionArguments(options: string): string[] {
  const tokens = options.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/gu) ?? [];
  return tokens.map((token) =>
    token.replaceAll(/"((?:\\.|[^"\\])*)"/gu, (_match, value: string) =>
      value.replaceAll(/\\(.)/gu, '$1'),
    ),
  );
}
