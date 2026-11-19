import { resolveAstroSemanticToolchain } from '#checkers';
import {
  readAnalysisFileDigest,
  readAnalysisInput,
} from '#utils/analysis-input';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { types } from 'node:util';
import ts from 'typescript';
import { resolveSvelteSemanticToolchain } from '../svelte-semantic/toolchain';
import { analysisHash } from './identity';
import { packageLocation } from './installation-locations';

interface ToolSelection {
  packages: [string, string][];
  entries: string[];
  files: string[];
}

export interface FrameworkTools {
  identity: string;
  files: string[];
  lookups: string[];
  isCurrent(): boolean;
}

function astroTools(root: string): ToolSelection {
  const { paths, runtimeModules } = resolveAstroSemanticToolchain(root);
  const compiler = runtimeModules.find(
    (entry) => entry.specifier === '@astrojs/compiler/sync',
  );
  if (compiler === undefined)
    throw new Error('Unobserved Astro compiler entry.');
  const project = path.join(root, 'package.json');
  return {
    packages: [
      [project, paths.astro],
      [project, paths.check],
      [project, paths.leafTypeScript],
      [paths.check, paths.languageServer],
      [paths.check, paths.typeScript],
      [paths.languageServer, paths.compiler],
      [paths.languageServer, paths.languageCore],
      [paths.languageServer, paths.volarKit],
      [paths.languageServer, paths.vscodeUri],
      [paths.volarKit, paths.volarTypeScript],
    ],
    entries: runtimeModules.map((entry) => entry.file),
    // The synchronous Astro compiler opens this WASM itself, outside require().
    files: [
      ...Object.values(paths),
      path.resolve(path.dirname(compiler.file), '../astro.wasm'),
    ],
  };
}

function svelteTools(root: string): ToolSelection {
  const { compilerPath, transformPath, typeScriptPath } =
    resolveSvelteSemanticToolchain(root);
  const entries = [compilerPath, transformPath, typeScriptPath];
  const project = path.join(root, 'package.json');
  return {
    entries,
    files: [],
    packages: entries.map((entry) => [project, entry]),
  };
}

function hasQualifiedPackage(
  parent: string,
  file: string,
  lookups: Set<string>,
  files: Set<string>,
): boolean {
  const location = packageLocation(normalizeAbsolutePath(file));
  if (location === undefined) return false;
  const manifest = path.join(location, 'package.json');
  files.add(manifest);
  if (location === packageLocation(normalizeAbsolutePath(parent))) return true;
  const name = location.slice(
    location.lastIndexOf('/node_modules/') + '/node_modules/'.length,
  );
  const directories = createRequire(parent).resolve.paths(name) ?? [];
  for (const directory of directories) {
    const candidate = path.join(directory, name, 'package.json');
    lookups.add(candidate);
    if (!ts.sys.fileExists(candidate)) continue;
    return (
      normalizeAbsolutePath(realpathSync.native(candidate)) ===
      normalizeAbsolutePath(manifest)
    );
  }
  return false;
}

/**
Only an eligible current project can select executable toolchain modules.
The persisted graph stores their fingerprint and physical read receipts.
*/
export function readFrameworkTools(
  family: 'astro' | 'svelte',
  packageRoot: string,
): FrameworkTools | undefined {
  try {
    const selected =
      family === 'astro' ? astroTools(packageRoot) : svelteTools(packageRoot);
    const modules = createRequire(path.join(packageRoot, 'package.json')).cache;
    const files = new Set([
      ...selected.files,
      path.join(packageRoot, 'package.json'),
    ]);
    const lookups = new Set<string>();
    if (
      selected.packages.some(
        ([parent, file]) => !hasQualifiedPackage(parent, file, lookups, files),
      )
    )
      return undefined;
    const children = new Map<string, string[]>();
    const loadedModules = new Map<NodeJS.Module, NodeJS.Module[]>();
    const pending = selected.entries.map((file) => path.normalize(file));
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (children.has(file)) continue;
      const loaded = modules[file];
      if (
        !loaded?.loaded ||
        types.isModuleNamespaceObject(loaded.exports) ||
        file.endsWith('.node')
      )
        return undefined;
      const imports = loaded.children
        .map((child) => child.filename)
        .sort(compareCodeUnits);
      if (
        imports.some(
          (child) => !hasQualifiedPackage(file, child, lookups, files),
        )
      )
        return undefined;
      children.set(file, imports);
      loadedModules.set(loaded, [...loaded.children]);
      files.add(file);
      pending.push(...imports);
    }
    const installation = {
      files: [...files].sort(compareCodeUnits),
      lookups: [...lookups].sort(compareCodeUnits),
    };
    return {
      ...installation,
      // A framework may require another transform while preparing a component.
      // Previously qualified file and lookup receipts cover the original closure.
      isCurrent: () =>
        loadedModules
          .entries()
          .every(
            ([loaded, previous]) =>
              modules[loaded.filename] === loaded &&
              loaded.children.length === previous.length &&
              previous.every(
                (child, index) => child === loaded.children[index],
              ),
          ),
      identity: analysisHash([
        family,
        selected,
        Object.fromEntries(children),
        installation,
      ]),
    };
  } catch {
    return undefined;
  }
}

export function observeFrameworkTools(tools: FrameworkTools): void {
  for (const file of tools.lookups)
    readAnalysisInput(file, () => ts.sys.fileExists(file), 'file');
  for (const file of tools.files) readAnalysisFileDigest(file);
}
