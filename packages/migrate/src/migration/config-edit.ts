import type { RegionExcludeConfig } from 'limina/internal/migration';
import ts from 'typescript';
import { StaticConfigSyntax, unsupportedConfigEdit } from './config-syntax';

function editRegions(
  syntax: StaticConfigSyntax,
  regions: ts.ObjectLiteralExpression,
  entries: string,
): string {
  const property = syntax.property(regions, 'exclude');
  return property
    ? editExclusions(syntax, syntax.resolve(property.initializer), entries)
    : syntax.insert(regions, `exclude: [${entries}]`);
}

function editExclusions(
  syntax: StaticConfigSyntax,
  expression: ts.Expression,
  entries: string,
): string {
  if (!ts.isArrayLiteralExpression(expression)) return unsupportedConfigEdit();
  return expression.elements.some(ts.isSpreadElement)
    ? unsupportedConfigEdit()
    : syntax.insert(expression, entries);
}

/**
Edits source syntax; the evaluated module is never serialized.
*/
export function addStaticConfigExclusions(
  fileName: string,
  text: string,
  additions: readonly RegionExcludeConfig[],
): string {
  if (additions.length === 0) return text;
  const syntax = new StaticConfigSyntax(fileName, text);
  const root = syntax.root();
  const entries = additions
    .map((entry) => JSON.stringify(entry, null, 2))
    .join(',\n');
  const property = syntax.property(root, 'regions');
  return property
    ? editRegions(
        syntax,
        syntax.object(syntax.resolve(property.initializer)),
        entries,
      )
    : syntax.insert(root, `regions: { exclude: [${entries}] }`);
}
