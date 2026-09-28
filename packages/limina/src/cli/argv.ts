import type { CheckIssueFilterHelpKind } from '../check-reporting/filter-help';
import {
  assertHumanIssueInventoryLimit,
  parseIssueInventoryFormat,
  parseIssueInventoryLimit,
} from './parse';
import type { GlobalFlags } from './types';

const GLOBAL_OPTION_FIELDS = new Map<string, keyof GlobalFlags>([
  ['--config', 'config'],
  ['--config-loader', 'configLoader'],
  ['--mode', 'mode'],
]);
const FILTER_HELP_KINDS = new Map<string, CheckIssueFilterHelpKind>([
  ['--checker', 'checker'],
  ['--package', 'package'],
  ['-p', 'package'],
  ['--rule', 'rule'],
  ['--task', 'task'],
]);

interface GlobalOptionDescriptor {
  field: keyof GlobalFlags;
  inlineValue?: string;
  separate: boolean;
}

function getInlineOptionValue(
  argument: string | undefined,
  optionName: string,
): string | undefined {
  if (argument === undefined) return undefined;
  const prefix = `${optionName}=`;
  if (!argument.startsWith(prefix)) return undefined;
  return argument.slice(prefix.length);
}

function getSeparateOptionValue(
  argv: readonly string[],
  index: number,
): string | undefined {
  const value = argv[index + 1];
  if (value === undefined) return undefined;
  return value.startsWith('-') ? undefined : value;
}

function getInlineGlobalOption(
  argument: string,
): GlobalOptionDescriptor | undefined {
  const entry = [...GLOBAL_OPTION_FIELDS].find(([name]) =>
    argument.startsWith(`${name}=`),
  );
  if (entry === undefined) return undefined;
  const [name, field] = entry;
  return {
    field,
    inlineValue: argument.slice(name.length + 1),
    separate: false,
  };
}

function getGlobalOptionDescriptor(
  argument: string | undefined,
): GlobalOptionDescriptor | undefined {
  if (argument === undefined) return undefined;
  const exactField = GLOBAL_OPTION_FIELDS.get(argument);
  if (exactField !== undefined) {
    return { field: exactField, separate: true };
  }
  return getInlineGlobalOption(argument);
}

function applyGlobalOption(options: {
  argv: readonly string[];
  descriptor: GlobalOptionDescriptor;
  flags: GlobalFlags;
  index: number;
}): number {
  if (!options.descriptor.separate) {
    options.flags[options.descriptor.field] = options.descriptor.inlineValue;
    return 0;
  }
  const value = getSeparateOptionValue(options.argv, options.index);
  if (value === undefined) return 0;
  options.flags[options.descriptor.field] = value;
  return 1;
}

function readGlobalOptionAt(options: {
  argv: readonly string[];
  flags: GlobalFlags;
  index: number;
}): number {
  const descriptor = getGlobalOptionDescriptor(options.argv[options.index]);
  if (descriptor === undefined) return 0;
  return applyGlobalOption({ ...options, descriptor });
}

function isGlobalOption(argument: string | undefined): boolean {
  return getGlobalOptionDescriptor(argument) !== undefined;
}

function shouldSkipNextArgument(argument: string | undefined): boolean {
  const descriptor = getGlobalOptionDescriptor(argument);
  return descriptor?.separate === true;
}

export function readGlobalFlagsFromArgv(argv: readonly string[]): GlobalFlags {
  const flags: GlobalFlags = {};
  for (let index = 2; index < argv.length; index += 1) {
    index += readGlobalOptionAt({ argv, flags, index });
  }
  return flags;
}

function matchOptionAt(options: {
  argument: string | undefined;
  argv: readonly string[];
  index: number;
  optionName: string;
}): string | undefined {
  const inline = getInlineOptionValue(options.argument, options.optionName);
  if (inline !== undefined) return inline;
  if (options.argument !== options.optionName) return undefined;
  return getSeparateOptionValue(options.argv, options.index);
}

export function readArgvOptionValue(
  argv: readonly string[],
  optionName: string,
): string | undefined {
  for (let index = 2; index < argv.length; index += 1) {
    const value = matchOptionAt({
      argument: argv[index],
      argv,
      index,
      optionName,
    });
    if (value !== undefined) return value;
  }
  return undefined;
}

function toCommandCandidate(argument: string): string | undefined {
  if (argument.startsWith('-')) return undefined;
  return argument;
}

function getCommandCandidate(argument: string | undefined): string | undefined {
  if (argument === undefined) return undefined;
  if (isGlobalOption(argument)) return undefined;
  return toCommandCandidate(argument);
}

function scanCommandArgument(argument: string | undefined): {
  candidate: string | undefined;
  skipCount: number;
} {
  return {
    candidate: getCommandCandidate(argument),
    skipCount: Number(shouldSkipNextArgument(argument)),
  };
}

export function getPrimaryCliCommandName(
  argv: readonly string[],
): string | undefined {
  for (let index = 2; index < argv.length; index += 1) {
    const scan = scanCommandArgument(argv[index]);
    index += scan.skipCount;
    if (scan.candidate !== undefined) return scan.candidate;
  }
  return undefined;
}

function isLimitArgument(argument: string): boolean {
  if (argument === '--limit') return true;
  return argument.startsWith('--limit=');
}

function getLimitArgumentIndex(argv: readonly string[]): number {
  return argv.findIndex(isLimitArgument);
}

function getArgumentOrEmpty(argv: readonly string[], index: number): string {
  const value = argv[index];
  return value === undefined ? '' : value;
}

function getLimitArgumentValue(argv: readonly string[], index: number): string {
  const argument = getArgumentOrEmpty(argv, index);
  const inlineValue = getInlineOptionValue(argument, '--limit');
  if (inlineValue !== undefined) return inlineValue;
  return getArgumentOrEmpty(argv, index + 1);
}

function isIssueInventoryCommand(argv: readonly string[]): boolean {
  return (
    getPrimaryCliCommandName(argv) === 'check' && argv.includes('--issues')
  );
}

function normalizeArgumentIndex(index: number): number | null {
  if (index === -1) return null;
  return index;
}

function getIssueInventoryLimitIndex(argv: readonly string[]): number | null {
  if (!isIssueInventoryCommand(argv)) return null;
  return normalizeArgumentIndex(getLimitArgumentIndex(argv));
}

function getInventoryFormat(argv: readonly string[]) {
  const format = parseIssueInventoryFormat(
    readArgvOptionValue(argv, '--format'),
  );
  return format === undefined ? 'human' : format;
}

export function assertIssueInventoryLimitArgv(argv: readonly string[]): void {
  const limitIndex = getIssueInventoryLimitIndex(argv);
  if (limitIndex === null) return;
  parseIssueInventoryLimit(getLimitArgumentValue(argv, limitIndex));
  assertHumanIssueInventoryLimit({
    format: getInventoryFormat(argv),
    limitExplicit: true,
  });
}

function isHelpArgument(value: string | undefined): boolean {
  return value === '--help' || value === '-h';
}

function getFilterHelpKindAt(
  args: readonly string[],
  index: number,
): CheckIssueFilterHelpKind | null {
  const kind = FILTER_HELP_KINDS.get(getArgumentOrEmpty(args, index));
  if (kind === undefined) return null;
  if (isHelpArgument(args[index + 1])) return kind;
  return null;
}

function findFilterHelpKind(
  args: readonly string[],
): CheckIssueFilterHelpKind | null {
  for (const index of args.keys()) {
    const kind = getFilterHelpKindAt(args, index);
    if (kind !== null) return kind;
  }
  return null;
}

export function parseCheckIssueFilterHelpKind(
  argv: readonly string[],
): CheckIssueFilterHelpKind | null {
  if (getPrimaryCliCommandName(argv) !== 'check') return null;
  const args = argv.slice(2);
  if (!args.includes('--issues')) return null;
  return findFilterHelpKind(args);
}
