import { existsSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { DistributionPackageJson } from './helpers';

export async function assertPackageModuleClosure(
  root: string,
  manifest: DistributionPackageJson,
): Promise<void> {
  const allowed = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
  const developmentTypes = new Set(Object.keys(manifest.devDependencies ?? {}));
  const files = await readdir(root, { recursive: true });
  const imports = new Map<string, string[]>();
  for (const file of files) {
    if (!/\.(?:js|d\.ts)$/u.test(file)) continue;
    const filePath = path.join(root, file);
    const text = await readFile(filePath, 'utf8');
    const syntax = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifiers.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        specifiers.push(node.arguments[0].text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        specifiers.push(node.argument.literal.text);
      ts.forEachChild(node, visit);
    };
    visit(syntax);
    imports.set(file, specifiers);
  }
  const publicDeclarations = new Set<string>();
  const pendingDeclarations: string[] = [];
  const addPublicEntry = (value: unknown): void => {
    if (typeof value === 'string') {
      const declaration = value.replace(/\.js$/u, '.d.ts');
      const file = path.relative(root, path.resolve(root, declaration));
      if (file.endsWith('.d.ts') && imports.has(file))
        pendingDeclarations.push(file);
    } else if (value && typeof value === 'object')
      for (const entry of Object.values(value)) addPublicEntry(entry);
  };
  addPublicEntry(manifest.types);
  addPublicEntry(manifest.exports);
  while (pendingDeclarations.length > 0) {
    const file = pendingDeclarations.pop()!;
    if (publicDeclarations.has(file)) continue;
    publicDeclarations.add(file);
    const specifiers = imports.get(file) ?? [];
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const target = path.relative(
        root,
        path
          .resolve(root, path.dirname(file), specifier)
          .replace(/\.js$/u, '.d.ts'),
      );
      if (imports.has(target)) pendingDeclarations.push(target);
    }
  }
  for (const [file, specifiers] of imports) {
    const filePath = path.join(root, file);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(filePath), specifier);
        const declaration = file.endsWith('.d.ts')
          ? target.replace(/\.js$/u, '.d.ts')
          : target;
        await access(existsSync(target) ? target : declaration);
      } else if (!specifier.startsWith('node:')) {
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/', 1)[0]!;
        if (
          specifier.startsWith('#') ||
          name.startsWith('@limina/') ||
          specifier.startsWith('limina/internal/') ||
          (!allowed.has(name) &&
            // The retained, unexported workspace support declaration can
            // describe build-time types. Public declarations and runtime JS
            // must be consumable without development dependencies.
            !(
              file.endsWith('.d.ts') &&
              !publicDeclarations.has(file) &&
              developmentTypes.has(name)
            ))
        ) {
          throw new Error(
            `Undeclared or workspace-only published import in ${file}: ${specifier}`,
          );
        }
      }
    }
  }
}
