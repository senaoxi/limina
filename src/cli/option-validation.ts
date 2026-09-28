import type { BuildFlags, CheckerFlags } from './types';

const CHECKER_OPTIONS = new Set([
  '--',
  'config',
  'configLoader',
  'mode',
  'preset',
  'w',
  'watch',
  'verbose',
]);
const BUILD_OPTIONS = new Set([
  '--',
  'config',
  'configLoader',
  'mode',
  'preset',
  'raw',
  'verbose',
  'w',
  'watch',
]);

function getUnknownOption(
  flags: object,
  known: ReadonlySet<string>,
): string | undefined {
  return Object.keys(flags).find((option) => !known.has(option));
}

function rejectUnknownOptions(flags: object, known: ReadonlySet<string>): void {
  const unknown = getUnknownOption(flags, known);
  if (unknown === undefined) return;
  throw new Error(`Unknown option: --${unknown}.`);
}

export function rejectUnknownCheckerOptions(flags: CheckerFlags): void {
  rejectUnknownOptions(flags, CHECKER_OPTIONS);
}

export function rejectUnknownBuildOptions(flags: BuildFlags): void {
  rejectUnknownOptions(flags, BUILD_OPTIONS);
}

export function getCheckerWatchFlag(flags: CheckerFlags): boolean | undefined {
  if (flags.watch !== undefined) return flags.watch;
  return flags.w;
}

export function getBuildWatchFlag(flags: BuildFlags): boolean | undefined {
  if (flags.watch !== undefined) return flags.watch;
  return flags.w;
}
