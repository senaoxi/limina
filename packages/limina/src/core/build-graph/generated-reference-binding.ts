import type { ResolvedLiminaInputs } from '#config/runner';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
import { assertGeneratedManifestBinding } from './generated-manifest-binding';
import { readImplicitReferences } from './generated/config-readers';
import type {
  GeneratedBuildModule,
  GeneratedTsconfigGraphResult,
  GovernedSourceUnit,
} from './types';

type ReferenceGraph = Pick<
  GeneratedTsconfigGraphResult,
  | 'generatedFiles'
  | 'governedSources'
  | 'sourceToDts'
  | 'dtsToSource'
  | 'sourceToBuild'
  | 'configToOutputBuild'
  | 'checkerEntries'
  | 'ownershipPlan'
  | 'manifest'
>;

function references(graph: ReferenceGraph, file: string): Set<string> {
  const text = graph.generatedFiles.get(file);
  if (text === undefined) throw new Error(`Missing generated config: ${file}`);
  const value = JSON.parse(text) as { references?: { path: string }[] };
  return new Set(
    (value.references ?? []).map((reference) => {
      if (typeof reference.path !== 'string')
        throw new Error('Invalid generated reference.');
      return normalizeAbsolutePath(
        path.resolve(path.dirname(file), reference.path),
      );
    }),
  );
}
interface ProjectIdentity {
  checker: string;
  source: string;
}
class GeneratedReferenceBinding {
  readonly #graph: ReferenceGraph;
  readonly #config: ResolvedLiminaInputs;
  constructor(graph: ReferenceGraph, config: ResolvedLiminaInputs) {
    this.#graph = graph;
    this.#config = config;
  }
  #declaration(identity: ProjectIdentity): string | undefined {
    return this.#graph.sourceToDts.get(identity.checker)?.get(identity.source);
  }
  #output(identity: ProjectIdentity): GeneratedBuildModule | undefined {
    return this.#graph.configToOutputBuild
      .get(identity.checker)
      ?.get(identity.source);
  }
  #build(identity: ProjectIdentity): GeneratedBuildModule | undefined {
    return this.#graph.sourceToBuild
      .get(identity.checker)
      ?.get(identity.source);
  }
  #assertReferences(file: string, expected: Iterable<string>): void {
    const actual = references(this.#graph, file);
    const wanted = new Set(expected);
    if (actual.size !== wanted.size || !actual.isSubsetOf(wanted))
      throw new Error(
        `Generated references differ from their source projection: ${file}`,
      );
  }
  #outputForDeclaration(declaration: string): string {
    for (const [checker, sources] of this.#graph.dtsToSource) {
      const source = sources.get(declaration);
      if (source !== undefined) return this.#requireOutput({ checker, source });
    }
    throw new Error(`Unmapped output reference: ${declaration}`);
  }
  #requireOutput(identity: ProjectIdentity): string {
    const output = this.#output(identity);
    if (output === undefined)
      throw new Error(`Unmapped output: ${identity.source}`);
    return output.path;
  }
  #sourceReferences(source: string): string[] {
    return (
      this.#graph.ownershipPlan.solutions.get(source)?.sourceConfigPaths ?? []
    );
  }
  #solutionReferences(identity: ProjectIdentity): string[] {
    return this.#sourceReferences(identity.source)
      .filter(
        (source) =>
          this.#graph.ownershipPlan.typeConfigs.get(source)?.finalOwner ===
          identity.checker,
      )
      .map((source) => {
        const module = this.#build({ checker: identity.checker, source });
        if (module === undefined)
          throw new Error(`Unmapped solution member: ${source}`);
        return module.path;
      });
  }
  #assertImplicitReferences(
    identity: ProjectIdentity,
    unit: GovernedSourceUnit,
  ): void {
    const implicit = readImplicitReferences(this.#config, identity.source);
    if (implicit.problems.length > 0)
      throw new Error(implicit.problems.join('\n'));
    for (const reference of implicit.implicitRefs)
      this.#assertImplicitTarget(
        identity.checker,
        unit,
        reference.targetConfigPath,
      );
  }
  #assertImplicitTarget(
    checker: string,
    unit: GovernedSourceUnit,
    source: string,
  ): void {
    const target = this.#declaration({ checker, source });
    if (target === undefined || !unit.declarationReferences.has(target))
      throw new Error(`Unbound implicit reference: ${source}`);
  }
  #assertLeaf(identity: ProjectIdentity, unit: GovernedSourceUnit): void {
    const declaration = this.#declaration(identity);
    if (
      unit.configPath !== identity.source ||
      unit.primaryCheckerName !== identity.checker
    )
      throw new Error(
        `Inconsistent governed source identity: ${identity.source}`,
      );
    const projection = unit.buildProjection;
    if (
      'dtsConfigPath' in projection &&
      (declaration !== projection.dtsConfigPath ||
        this.#graph.dtsToSource.get(identity.checker)?.get(declaration) !==
          identity.source)
    )
      throw new Error(
        `Unbound source declaration projection: ${identity.source}`,
      );
    const buildPath =
      'buildConfigPath' in projection
        ? projection.buildConfigPath
        : 'dtsConfigPath' in projection
          ? projection.dtsConfigPath
          : undefined;
    if (buildPath !== undefined && this.#build(identity)?.path !== buildPath)
      throw new Error(`Unbound source build projection: ${identity.source}`);
    if (declaration === undefined) return;
    this.#assertReferences(declaration, unit.declarationReferences);
    this.#assertImplicitReferences(identity, unit);
    this.#assertLeafOutput(identity, unit);
  }
  #assertLeafOutput(identity: ProjectIdentity, unit: GovernedSourceUnit): void {
    const output = this.#output(identity);
    if (output?.kind !== 'project') return;
    this.#assertReferences(
      output.path,
      [...unit.declarationReferences].map((reference) =>
        this.#outputForDeclaration(reference),
      ),
    );
  }
  #assertSolution(
    identity: ProjectIdentity,
    module: GeneratedBuildModule,
  ): void {
    if (module.kind !== 'solution') return;
    const declaration = this.#declaration(identity);
    const expected =
      declaration === undefined
        ? this.#solutionReferences(identity)
        : [declaration];
    this.#assertReferences(module.path, expected);
  }
  #outputSolutionReferences(
    identity: ProjectIdentity,
    seen: Set<string>,
  ): string[] {
    if (seen.has(identity.source)) return [];
    seen.add(identity.source);
    return this.#sourceReferences(identity.source)
      .filter(
        (source) =>
          this.#graph.ownershipPlan.typeConfigs.get(source)?.finalOwner ===
          identity.checker,
      )
      .flatMap((source) =>
        this.#outputMembers({ checker: identity.checker, source }, seen),
      );
  }
  #outputMembers(identity: ProjectIdentity, seen: Set<string>): string[] {
    const output = this.#output(identity);
    return output?.kind === 'project'
      ? [output.path]
      : this.#outputSolutionReferences(identity, seen);
  }
  #assertOutputSolution(
    identity: ProjectIdentity,
    module: GeneratedBuildModule,
  ): void {
    if (module.kind === 'solution')
      this.#assertReferences(
        module.path,
        this.#outputSolutionReferences(identity, new Set()),
      );
  }
  #assertLeaves(): void {
    for (const [checker, units] of this.#graph.governedSources)
      for (const [source, unit] of units)
        this.#assertLeaf({ checker, source }, unit);
  }
  #assertSolutions(): void {
    for (const [checker, sources] of this.#graph.sourceToBuild)
      for (const [source, module] of sources)
        this.#assertSolution({ checker, source }, module);
  }
  #assertOutputSolutions(): void {
    for (const [checker, sources] of this.#graph.configToOutputBuild)
      for (const [source, module] of sources)
        this.#assertOutputSolution({ checker, source }, module);
  }
  #assertSourceMaps(): void {
    for (const [checker, paths] of this.#graph.sourceToDts) {
      const inverse = this.#graph.dtsToSource.get(checker);
      if (inverse?.size !== paths.size)
        throw new Error(`Declaration mappings are not bijective: ${checker}`);
      for (const [source, declaration] of paths)
        if (
          this.#graph.ownershipPlan.typeConfigs.get(source)?.finalOwner !==
            checker ||
          inverse.get(declaration) !== source
        )
          throw new Error(
            `Unbound declaration source identity: ${checker}: ${source}`,
          );
    }
    for (const mappings of [
      this.#graph.sourceToBuild,
      this.#graph.configToOutputBuild,
    ])
      for (const [checker, modules] of mappings)
        for (const [source, module] of modules)
          this.#assertModuleOwner({ checker, source }, module);
  }
  #assertModuleOwner(
    identity: ProjectIdentity,
    module: GeneratedBuildModule,
  ): void {
    const plan = this.#graph.ownershipPlan;
    if (plan.typeConfigs.get(identity.source)?.finalOwner === identity.checker)
      return;
    const solution = plan.solutions.get(identity.source);
    if (
      module.kind === 'solution' &&
      solution?.sourceConfigPaths.some(
        (source) =>
          plan.typeConfigs.get(source)?.finalOwner === identity.checker,
      )
    )
      return;
    throw new Error(
      `Unbound generated module owner: ${identity.checker}: ${identity.source}`,
    );
  }
  assertBound(): void {
    assertGeneratedManifestBinding(this.#graph, this.#config.rootDir);
    this.#assertSourceMaps();
    this.#assertLeaves();
    this.#assertSolutions();
    this.#assertOutputSolutions();
    for (const [checker, entry] of this.#graph.checkerEntries) {
      const expected = this.#graph.ownershipPlan.typeConfigs
        .values()
        .filter((state) => state.finalOwner === checker)
        .map((state) => {
          const module = this.#build({ checker, source: state.configPath });
          if (module === undefined)
            throw new Error(`Missing source build target: ${state.configPath}`);
          return module.path;
        });
      this.#assertReferences(entry, expected);
    }
  }
}
/**
Validate actual generated configurations against the existing source projection before materialization.
*/
export function hasBoundGeneratedReferences(
  graph: ReferenceGraph,
  config: ResolvedLiminaInputs,
): boolean {
  try {
    new GeneratedReferenceBinding(graph, config).assertBound();
    return true;
  } catch {
    return false;
  }
}

export function assertGeneratedReferenceBinding(
  graph: ReferenceGraph,
  config: ResolvedLiminaInputs,
): void {
  new GeneratedReferenceBinding(graph, config).assertBound();
}
