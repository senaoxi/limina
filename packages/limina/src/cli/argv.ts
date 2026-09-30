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
  return argument.startsWith(prefix)
    ? argument.slice(prefix.length)
    : undefined;
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
  return exactField === undefined
    ? getInlineGlobalOption(argument)
    : { field: exactField, separate: true };
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
  return descriptor === undefined
    ? 0
    : applyGlobalOption({ ...options, descriptor });
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
  return options.argument === options.optionName
    ? getSeparateOptionValue(options.argv, options.index)
    : undefined;
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
  if (argument === '--') return argument;
  return argument.startsWith('-') ? undefined : argument;
}

function getCommandCandidate(argument: string | undefined): string | undefined {
  if (argument === undefined) return undefined;
  return isGlobalOption(argument) ? undefined : toCommandCandidate(argument);
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

export function getPrimaryCliCommandIndex(
  argv: readonly string[],
): number | undefined {
  for (let index = 2; index < argv.length; index += 1) {
    const scan = scanCommandArgument(argv[index]);
    index += scan.skipCount;
    if (scan.candidate !== undefined) return index;
  }
  return undefined;
}

export function getPrimaryCliCommandName(
  argv: readonly string[],
): string | undefined {
  const index = getPrimaryCliCommandIndex(argv);
  return index === undefined ? undefined : argv[index];
}

function isLimitArgument(argument: string): boolean {
  return argument === '--limit' || argument.startsWith('--limit=');
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
  return inlineValue === undefined
    ? getArgumentOrEmpty(argv, index + 1)
    : inlineValue;
}

function isIssueInventoryCommand(argv: readonly string[]): boolean {
  return (
    getPrimaryCliCommandName(argv) === 'check' && argv.includes('--issues')
  );
}

function normalizeArgumentIndex(index: number): number | null {
  return index === -1 ? null : index;
}

function getIssueInventoryLimitIndex(argv: readonly string[]): number | null {
  return isIssueInventoryCommand(argv)
    ? normalizeArgumentIndex(getLimitArgumentIndex(argv))
    : null;
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
  arguments_: readonly string[],
  index: number,
): CheckIssueFilterHelpKind | null {
  const kind = FILTER_HELP_KINDS.get(getArgumentOrEmpty(arguments_, index));
  if (kind === undefined) return null;
  return isHelpArgument(arguments_[index + 1]) ? kind : null;
}

function findFilterHelpKind(
  arguments_: readonly string[],
): CheckIssueFilterHelpKind | null {
  for (const index of arguments_.keys()) {
    const kind = getFilterHelpKindAt(arguments_, index);
    if (kind !== null) return kind;
  }
  return null;
}

export function parseCheckIssueFilterHelpKind(
  argv: readonly string[],
): CheckIssueFilterHelpKind | null {
  if (getPrimaryCliCommandName(argv) !== 'check') return null;
  const arguments_ = argv.slice(2);
  return arguments_.includes('--issues')
    ? findFilterHelpKind(arguments_)
    : null;
}
