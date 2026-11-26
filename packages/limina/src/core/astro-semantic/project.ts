import {
  type AstroSemanticProject,
  type AstroSemanticProjectSnapshotInput,
  type AstroSemanticToolchain,
  createAstroSemanticProject,
} from '#checkers';
import { parseFrameworkProjectConfig } from '../../checker/framework-project-config';
import type { AutoScopeProject } from '../build-graph/auto-checker-types';

const projectsBySource = new WeakMap<
  AutoScopeProject,
  Map<string, AstroSemanticProject>
>();

export function getAstroSourceProject(
  source: AutoScopeProject,
  packageRootDirectory: string,
): AstroSemanticProject {
  let projects = projectsBySource.get(source);
  if (projects === undefined) {
    projects = new Map();
    projectsBySource.set(source, projects);
  }
  const prior = projects.get(packageRootDirectory);
  if (prior !== undefined) return prior;
  const snapshots = new WeakMap<
    AstroSemanticToolchain,
    AstroSemanticProjectSnapshotInput
  >();
  const project = createAstroSemanticProject({
    analysisGeneration: source.analysisGeneration,
    configPath: source.configPath,
    packageRootDir: packageRootDirectory,
    projectFingerprint: source.configPath,
    readSnapshot(toolchain) {
      const prior = snapshots.get(toolchain);
      if (prior !== undefined) return prior;
      // AstroCheck passes its Astro, Svelte and Vue plugins to Volar Kit in this order.
      const extraFileExtensions = [
        toolchain.astroCore.getAstroLanguagePlugin(),
        toolchain.sveltePlugin.getLanguagePlugin(),
        toolchain.vuePlugin.getLanguagePlugin(),
      ].flatMap((plugin) => plugin.typescript?.extraFileExtensions ?? []);
      const { configClosure, parsed } = parseFrameworkProjectConfig({
        configPath: source.configPath,
        extraFileExtensions,
        tsModule: toolchain.tsModule,
        virtualFiles: source.virtualFiles,
      });
      const snapshot = {
        checkerExtensions: source.context.extensions,
        compilerOptions: parsed.options,
        configClosure,
        fileNames: parsed.fileNames,
        projectReferences: parsed.projectReferences,
      };
      snapshots.set(toolchain, snapshot);
      return snapshot;
    },
  });
  projects.set(packageRootDirectory, project);
  return project;
}
