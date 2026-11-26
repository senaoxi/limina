import type { ResolvedLiminaInputs } from '#config/runner';
import { compareCodeUnits } from '#utils/collections';
import { isPathInsideDirectory, normalizeAbsolutePath } from '#utils/path';
import { createRequire } from 'node:module';
import path from 'pathe';
import ts from 'typescript';
import { parseFrameworkProjectConfig } from '../../checker/framework-project-config';
import {
  createSvelteSemanticProject,
  parseSvelteConfig,
  svelteCompilerOptions,
  svelteSemanticOptions,
} from '../svelte-semantic/project';
import {
  resolveSvelteSemanticToolchain,
  type SvelteSemanticToolchain,
} from '../svelte-semantic/toolchain';
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
  originalReferences: readonly ts.ProjectReference[],
  compiler: typeof ts,
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
  for (const reference of originalReferences)
    targets.add(
      normalizeAbsolutePath(compiler.resolveProjectReferencePath(reference)),
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

function validateProjectionToolchain(input: {
  check: string;
  source: string;
  toolchain: SvelteSemanticToolchain;
}): void {
  const fromCheck = createRequire(input.check);
  const fromSource = createRequire(input.source);
  const toolchainPaths = {
    'svelte/compiler': input.toolchain.compilerPath,
    typescript: input.toolchain.typeScriptPath,
    svelte2tsx: input.toolchain.transformPath,
  };
  if (
    Object.entries(toolchainPaths).some(([specifier, expected]) =>
      [fromCheck, fromSource].some(
        (require) =>
          normalizeAbsolutePath(require.resolve(specifier)) !== expected,
      ),
    )
  )
    throw new Error(
      `Svelte check projection changes the toolchain: ${input.source}`,
    );
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
  const checks = projects.map((project) => {
    const source = units.find(
      (unit) => unit.configPath === project.configPath,
    )!;
    const readSourceConfig = project.readSvelteSourceConfig;
    if (readSourceConfig === undefined)
      throw new Error(
        `Svelte check projection lacks source config inputs: ${project.configPath}`,
      );
    const toolchain = resolveSvelteSemanticToolchain(project.packageRootDir);
    const { tsModule } = toolchain;
    const original = readSourceConfig(tsModule);
    const check = svelteCheckConfigPath(project.configPath);
    validateProjectionToolchain({
      check,
      source: project.configPath,
      toolchain,
    });
    return {
      check,
      original,
      project,
      references: checkReferences(
        state,
        config,
        project.configPath,
        original.references,
        tsModule,
      ),
      source,
      tsModule,
    };
  });
  const referenceTargets = new Set(
    checks.flatMap(({ references }) => references),
  );
  const sourceConsumers = new Set(
    state.dependencyEdges
      .filter((edge) => edge.kind === 'framework-schedule')
      .map((edge) => edge.fromConfigPath),
  );
  let nextFiles: Map<string, string> | undefined;
  for (const { project, source, check, references, original } of checks) {
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
      svelteOptions: original.svelteOptions,
    });
    const content = `${JSON.stringify(projected, null, 2)}\n`;
    if (view.files.get(check) !== content) {
      nextFiles ??= new Map(view.files);
      nextFiles.set(check, content);
    }
    view.checkFiles.add(check);
    source.checkConfigPath = check;
    source.checkReferences = new Set(references);
    for (const capability of source.frameworkCapabilities)
      if (capability.family === 'svelte')
        capability.executionConfigPath = check;
  }
  if (nextFiles === undefined) return;
  // Both provisional and final checker views retain their independently observed bytes.
  view.files = nextFiles;
  const virtualFiles = config.virtualFiles?.size
    ? new Map([...config.virtualFiles, ...view.files])
    : view.files;
  for (const { project, source, check, tsModule } of checks) {
    const { parsed, configClosure } = parseSvelteConfig({
      configPath: check,
      tsModule,
      virtualFiles,
    });
    // Explicit staged files preserve the same options and references with either extension set.
    const physicalTypeScript =
      tsModule === ts
        ? parsed
        : parseFrameworkProjectConfig({
            configPath: check,
            tsModule: ts,
            virtualFiles,
            extraFileExtensions: [],
          }).parsed;
    const executionConfig = {
      configPath: check,
      options: physicalTypeScript.options,
      references: physicalTypeScript.projectReferences ?? [],
      virtualFiles,
    };
    project.executionConfig = executionConfig;
    source.executionConfig = executionConfig;
    source.svelteSemanticProject = createSvelteSemanticProject({
      configPath: project.configPath,
      resolverConfigPath: check,
      options: svelteCompilerOptions(parsed.options),
      extensions: source.context.extensions,
      fileNames: source.ownedFileNames,
      generation: source.svelteSemanticProject?.generation ?? 0,
      packageRootDir: project.packageRootDir,
      configClosure,
      virtualFiles,
      references: parsed.projectReferences,
      svelteOptions: svelteSemanticOptions(parsed.raw.svelteOptions),
    });
  }
}
