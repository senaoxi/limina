import type { JsonObject } from '#core/tsconfig/actions';
import { type Node, type ParseError, parseTree } from 'jsonc-parser';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';

const compilerFields = [
  'outDir',
  'rootDir',
  'declarationMap',
  'target',
  'declarationDir',
  'composite',
  'declaration',
  'emitDeclarationOnly',
  'incremental',
  'noEmit',
  'tsBuildInfoFile',
];
const outputFields = ['outDir', 'rootDir', 'declarationMap', 'target'];
const migrationPaths = [
  ['$schema'],
  ['references'],
  ['compilerOptions'],
  ['liminaOptions'],
  ['liminaOptions', 'outputs'],
  ...compilerFields.map((field) => ['compilerOptions', field]),
  ...outputFields.map((field) => ['liminaOptions', 'outputs', field]),
];

function isObjectRoot(root: Node | undefined): root is Node {
  return root?.type === 'object';
}

function parseMigrationText(content: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(content.replace(/^\uFEFF/u, ' '), errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) {
    throw new Error(
      'Migration JSONC must parse as a complete object before writing.',
    );
  }
  if (!isObjectRoot(root)) {
    throw new Error(
      'Migration JSONC must parse as a complete object before writing.',
    );
  }
  return root;
}

function children(node: Node | undefined): Node[] {
  return node?.children ?? [];
}

function propertyName(property: Node): unknown {
  return children(property)[0]?.value;
}

function assertUniquePath(root: Node, segments: readonly string[]): void {
  let current: Node | undefined = root;
  const traversed: string[] = [];
  for (const segment of segments) {
    traversed.push(segment);
    const matches: Node[] = children(current).filter(
      (property) => propertyName(property) === segment,
    );
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous migration JSONC: duplicate key at ${traversed.join('.')}; remove the duplicate before rerunning migration.`,
      );
    }
    current = children(matches[0])[1];
  }
}

export function assertUnambiguousMigrationText(content: string): void {
  const root = parseMigrationText(content);
  for (const segments of migrationPaths) assertUniquePath(root, segments);
}

export function assertMigrationTextMatchesPlan(
  content: string,
  expected: JsonObject,
): void {
  parseMigrationText(content);
  const actual: unknown = ts.parseConfigFileTextToJson(
    'tsconfig.json',
    content,
  ).config;
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(
      'Migration JSONC edits do not match the planned effective object; no targets were written.',
    );
  }
}
