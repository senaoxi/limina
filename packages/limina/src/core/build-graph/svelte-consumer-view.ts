import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { createRequire } from 'node:module';
import path from 'pathe';
import ts from 'typescript';
import { createSvelteSemanticProject } from '../svelte-semantic/project';
import { resolveSvelteSemanticToolchain } from '../svelte-semantic/toolchain';
import { parseTypeScriptProjectConfig } from '../typescript-semantic/project-references';
import { readImplicitReferences } from './generated/config-readers';
import type { GeneratedGraphPreparationState } from './prepare-state';
import {
  assertProducerBuildReceipt,
  type ProducerBuildReceipt,
  type ProducerDeclaration,
} from './producer-receipt';
import {
  createSvelteCheckConfig,
  svelteCheckConfigPath,
} from './svelte-check-config';

export interface SvelteDeclarationBinding extends ProducerDeclaration {
  mirrorFile: string;
}
export interface SvelteConsumerView {
  receipt: ProducerBuildReceipt;
  bindings: Map<string, SvelteDeclarationBinding>;
  files: Map<string, string>;
  checkFiles: Set<string>;
  mirrorRoot: string;
}

export function createSvelteConsumerView(
  state: GeneratedGraphPreparationState,
  receipt: ProducerBuildReceipt,
  root: string,
): void {
  assertProducerBuildReceipt(receipt);
  const mirrorRoot = normalizeAbsolutePath(
    path.join(root, '.limina', 'declarations', 'svelte'),
  );
  const bindings = createSvelteDeclarationBindings(receipt, root);
  const files = new Map(receipt.plan.generatedFiles);
  for (const [file, binding] of bindings) files.set(file, binding.content);
  state.svelteConsumerView = {
    receipt,
    bindings,
    files,
    checkFiles: new Set(),
    mirrorRoot,
  };
}

export function createSvelteDeclarationBindings(
  receipt: ProducerBuildReceipt,
  root: string,
): Map<string, SvelteDeclarationBinding> {
  const mirrorRoot = normalizeAbsolutePath(
    path.join(root, '.limina', 'declarations', 'svelte'),
  );
  const bindings = new Map<string, SvelteDeclarationBinding>();
  for (const declaration of receipt.declarations) {
    if (!isPathInsideDirectory(declaration.sourceFile, root))
      throw new Error(
        `Cannot mirror a declaration outside the workspace: ${declaration.sourceFile}`,
      );
    // The compiler supplies the emitted filename. Source-relative directories
    // retain relative import structure across independently emitted projects.
    const relativeDirectory = path.relative(
      root,
      path.dirname(declaration.sourceFile),
    );
    const mirrorFile = normalizeAbsolutePath(
      path.join(
        mirrorRoot,
        relativeDirectory,
        path.basename(declaration.outputFile),
      ),
    );
    const previous = bindings.get(mirrorFile);
    if (
      previous !== undefined &&
      previous.sourceFile !== declaration.sourceFile
    )
      throw new Error(`Ambiguous declaration mirror: ${mirrorFile}`);
    bindings.set(mirrorFile, { ...declaration, mirrorFile });
  }
  return bindings;
}

function checkReferences(
  state: GeneratedGraphPreparationState,
  config: ResolvedLiminaInputs,
  source: string,
): string[] {
  const targets = new Set(
    state.dependencyEdges
      .filter(
        (edge) =>
          edge.kind === 'framework-declaration' &&
          edge.fromConfigPath === source,
      )
      .map((edge) => edge.toConfigPath),
  );
  const implicit = readImplicitReferences(config, source);
  if (implicit.problems.length > 0)
    throw new Error(implicit.problems.join('\n'));
  for (const reference of implicit.implicitRefs)
    targets.add(reference.targetConfigPath);
  // Explicit effective references remain requirements even without a current import.
  const parsed = parseTypeScriptProjectConfig({
    configPath: source,
    tsModule: ts,
  });
  const originalReferences = parsed?.projectReferences ?? [];
  for (const reference of originalReferences)
    targets.add(
      normalizeAbsolutePath(ts.resolveProjectReferencePath(reference)),
    );
  const units = state.governedSourcesByChecker.values().toArray().flat();
  return [...targets]
    .map((target) => {
      const unit = units.find((candidate) => candidate.configPath === target);
      if (unit === undefined)
        throw new Error(`Unowned check reference: ${source} -> ${target}`);
      if (unit.primaryCheckerName === 'svelte-check')
        return svelteCheckConfigPath(target);
      if ('dtsConfigPath' in unit.buildProjection)
        return unit.buildProjection.dtsConfigPath;
      throw new Error(
        `Check reference has no supported execution projection: ${source} -> ${target}`,
      );
    })
    .sort(compareCodeUnits);
}

/**
Install a staged execution view without changing source ownership or roots.
*/
export function projectSvelteConsumerConfigs(
  state: GeneratedGraphPreparationState,
  config: ResolvedLiminaInputs,
): void {
  const view = state.svelteConsumerView;
  if (view === undefined) return;
  const projects = state.primaryProjectsByChecker.get('svelte-check') ?? [];
  const units = state.governedSourcesByChecker.get('svelte-check') ?? [];
  const checks = projects.map((project) => ({
    project,
    check: svelteCheckConfigPath(project.configPath),
    references: checkReferences(state, config, project.configPath),
  }));
  const referenceTargets = new Set(
    checks.flatMap(({ references }) => references),
  );
  const sourceConsumers = new Set(
    state.dependencyEdges
      .filter((edge) => edge.kind === 'framework-schedule')
      .map((edge) => edge.fromConfigPath),
  );
  for (const { project, check, references } of checks) {
    const source = units.find(
      (unit) => unit.configPath === project.configPath,
    )!;
    const original = parseTypeScriptProjectConfig({
      configPath: project.configPath,
      tsModule: ts,
    })!;
    const roots = [
      config.rootDir,
      view.mirrorRoot,
      ...(original.options.rootDirs ?? []).flatMap((root) =>
        isPathInsideDirectory(root, config.rootDir)
          ? [path.join(view.mirrorRoot, path.relative(config.rootDir, root))]
          : [],
      ),
    ];
    const projected = createSvelteCheckConfig({
      sourceConfigPath: project.configPath,
      checkConfigPath: check,
      fileNames: project.fileNames,
      options: original.options,
      references,
      declarationRoots: roots,
      sourceCheckRoot:
        sourceConsumers.has(project.configPath) && !referenceTargets.has(check)
          ? config.rootDir
          : undefined,
      svelteOptions: original.raw?.svelteOptions,
    });
    view.files.set(check, `${JSON.stringify(projected, null, 2)}\n`);
    view.checkFiles.add(check);
    source.checkConfigPath = check;
    source.checkReferences = new Set(references);
    for (const capability of source.frameworkCapabilities)
      if (capability.family === 'svelte')
        capability.executionConfigPath = check;
  }
  for (const project of projects) {
    const source = units.find(
      (unit) => unit.configPath === project.configPath,
    )!;
    const check = source.checkConfigPath!;
    const parsed = parseTypeScriptProjectConfig({
      configPath: check,
      tsModule: ts,
      virtualFiles: view.files,
    })!;
    const toolchain = resolveSvelteSemanticToolchain(project.packageRootDir);
    const fromCheck = createRequire(check);
    const fromSource = createRequire(project.configPath);
    if (
      ['svelte/compiler', 'typescript', 'svelte2tsx'].some(
        (specifier) =>
          fromCheck.resolve(specifier) !== fromSource.resolve(specifier),
      ) ||
      normalizeAbsolutePath(fromSource.resolve('svelte/compiler')) !==
        toolchain.compilerPath
    )
      throw new Error(
        `Svelte check projection changes the toolchain: ${project.configPath}`,
      );
    project.executionConfigPath = check;
    project.options = parsed.options;
    project.virtualFiles = view.files;
    source.svelteSemanticProject = createSvelteSemanticProject({
      configPath: project.configPath,
      resolverConfigPath: check,
      options: parsed.options,
      extensions: source.context.extensions,
      fileNames: source.ownedFileNames,
      generation: source.svelteSemanticProject?.generation ?? 0,
      packageRootDir: project.packageRootDir,
      configClosure: project.configClosure,
      virtualFiles: view.files,
      references: parsed.projectReferences,
      svelteOptions: parsed.raw?.svelteOptions,
    });
  }
}
