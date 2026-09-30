import { formatUnknownValue } from '#utils/values';
import type { z } from 'zod';
import {
  legacyAutoCheckerConfigReason,
  unsupportedCheckerNameReason,
} from './checkers';

interface IssueFormatContext {
  field: string;
  issue: z.core.$ZodIssue;
  pathSegments: PropertyKey[];
  value: unknown;
}

interface IssueFormatter {
  format(context: IssueFormatContext): string;
  matches(context: IssueFormatContext): boolean;
}

function formatPathSegment(segment: PropertyKey): string {
  if (typeof segment === 'number') return `[${segment}]`;
  const text = String(segment);
  return /^[A-Za-z_$][\w$]*$/u.test(text)
    ? `.${text}`
    : `[${JSON.stringify(text)}]`;
}

export function formatZodPath(pathSegments: readonly PropertyKey[]): string {
  return pathSegments.map(formatPathSegment).join('').replace(/^\./u, '');
}

function isUnavailable(value: unknown): boolean {
  return [undefined, null].includes(value as undefined | null);
}

export function getValueAtPath(
  value: unknown,
  pathSegments: readonly PropertyKey[],
): unknown {
  let current = value;
  for (const segment of pathSegments) {
    if (isUnavailable(current)) return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function formatConfigProblem(options: {
  context: IssueFormatContext;
  reason: string;
  title: string;
}): string {
  return [
    options.title,
    `  field: ${options.context.field}`,
    `  value: ${formatUnknownValue(
      getValueAtPath(options.context.value, options.context.pathSegments),
    )}`,
    `  reason: ${options.reason}`,
  ].join('\n');
}

function formatIssueReason(context: IssueFormatContext, title: string): string {
  return formatConfigProblem({
    context,
    reason: context.issue.message,
    title,
  });
}

function isMatchesField(context: IssueFormatContext, field: string): boolean {
  return context.field === field;
}

function isMatchesFieldTree(
  context: IssueFormatContext,
  field: string,
): boolean {
  return context.field === field || context.field.startsWith(`${field}.`);
}

function createExactFormatter(options: {
  field: string;
  reason: string;
  title: string;
}): IssueFormatter {
  return {
    format: (context) =>
      formatConfigProblem({
        context,
        reason: options.reason,
        title: options.title,
      }),
    matches: (context) => isMatchesField(context, options.field),
  };
}

function createTreeFormatter(options: {
  field: string;
  title: string;
}): IssueFormatter {
  return {
    format: (context) => formatIssueReason(context, options.title),
    matches: (context) => isMatchesFieldTree(context, options.field),
  };
}

function isNamedCheckerIssue(context: IssueFormatContext): boolean {
  const [root, collection] = context.pathSegments;
  return root === 'config' && collection === 'checkers';
}

function getCheckerField(context: IssueFormatContext): string {
  return `config.checkers.${String(context.pathSegments[2])}`;
}

function formatCheckerEntry(context: IssueFormatContext): string {
  const checkerField = getCheckerField(context);
  const reason =
    context.issue.message === legacyAutoCheckerConfigReason ||
    context.issue.message === unsupportedCheckerNameReason
      ? context.issue.message
      : 'checker entries must be objects.';
  return formatConfigProblem({
    context: { ...context, field: checkerField },
    reason,
    title: 'Invalid Limina checker config:',
  });
}

function formatNamedCheckerIssue(context: IssueFormatContext): string {
  return context.pathSegments.length === 3
    ? formatCheckerEntry(context)
    : formatIssueReason(context, 'Invalid Limina checker config:');
}

function formatCheckerCollection(context: IssueFormatContext): string {
  return formatConfigProblem({
    context,
    reason: 'config.checkers must be an object keyed by auto or checker name.',
    title: 'Invalid Limina checker config:',
  });
}

function isReleaseIgnorePattern(context: IssueFormatContext): boolean {
  return (
    context.pathSegments.slice(0, 3).join('.') === 'release.contentHash.ignore'
  );
}

const issueFormatters: readonly IssueFormatter[] = [
  createExactFormatter({
    field: 'config',
    reason: 'config must be an object.',
    title: 'Invalid Limina config:',
  }),
  createExactFormatter({
    field: 'execution',
    reason: 'execution must be an object.',
    title: 'Invalid Limina execution config:',
  }),
  createTreeFormatter({
    field: 'execution',
    title: 'Invalid Limina execution config:',
  }),
  {
    format: formatCheckerCollection,
    matches: (context) => isMatchesField(context, 'config.checkers'),
  },
  createTreeFormatter({
    field: 'config.checkers.mode',
    title: 'Invalid Limina checker config:',
  }),
  createTreeFormatter({
    field: 'config.checkers.exclude',
    title: 'Invalid Limina checker config:',
  }),
  createTreeFormatter({
    field: 'config.checkers.useTsgo',
    title: 'Invalid Limina checker config:',
  }),
  createTreeFormatter({
    field: 'config.imports',
    title: 'Invalid Limina import analysis config:',
  }),
  createTreeFormatter({
    field: 'config.source',
    title: 'Invalid Limina source boundary config:',
  }),
  createTreeFormatter({
    field: 'source.importAuthority',
    title: 'Invalid source import authority config:',
  }),
  createTreeFormatter({
    field: 'source',
    title: 'Invalid Limina source config:',
  }),
  {
    format: formatNamedCheckerIssue,
    matches: isNamedCheckerIssue,
  },
  createExactFormatter({
    field: 'release',
    reason: 'release must be an object.',
    title: 'Invalid Limina release config:',
  }),
  createExactFormatter({
    field: 'release.contentHash',
    reason: 'release.contentHash must be an object.',
    title: 'Invalid Limina release config:',
  }),
  createTreeFormatter({
    field: 'release.npmPackageJsonLint',
    title: 'Invalid Limina release config:',
  }),
  createExactFormatter({
    field: 'release.contentHash.baselineTag',
    reason: 'baselineTag must be a non-empty string or function.',
    title: 'Invalid Limina release config:',
  }),
  createExactFormatter({
    field: 'release.contentHash.builtinIgnore',
    reason: 'builtinIgnore must be a boolean.',
    title: 'Invalid Limina release config:',
  }),
  createExactFormatter({
    field: 'release.contentHash.ignore',
    reason: 'ignore must be an array of non-empty strings or function.',
    title: 'Invalid Limina release config:',
  }),
  {
    format: (context) =>
      formatConfigProblem({
        context,
        reason: 'ignore patterns must be non-empty strings.',
        title: 'Invalid Limina release config:',
      }),
    matches: isReleaseIgnorePattern,
  },
];

function findIssueFormatter(
  context: IssueFormatContext,
): IssueFormatter | undefined {
  return issueFormatters.find((formatter) => formatter.matches(context));
}

export function formatLiminaConfigShapeIssue(
  value: unknown,
  issue: z.core.$ZodIssue,
): string {
  const pathSegments = issue.path as PropertyKey[];
  if (pathSegments.length === 0) {
    return 'limina config must export or return an object.';
  }
  const context = {
    field: formatZodPath(pathSegments),
    issue,
    pathSegments,
    value,
  };
  const formatter = findIssueFormatter(context);
  return formatter === undefined
    ? formatIssueReason(context, 'Invalid Limina config:')
    : formatter.format(context);
}
