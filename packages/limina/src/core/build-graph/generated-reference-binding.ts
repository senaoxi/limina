import type { ResolvedLiminaInputs } from '#config/runner';
import { collectReferencePathInfosForConfig } from '#core/tsconfig/actions';
import { normalizeAbsolutePath } from '#utils/path';
import path from 'pathe';
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
    const collection = collectReferencePathInfosForConfig(
      this.#config.rootDir,
      source,
      this.#config.virtualFiles,
    );
    if (collection.problems.length > 0)
      throw new Error(collection.problems.join('\n'));
    return collection.references.map((reference) => reference.resolvedPath);
  }
  #solutionReferences(identity: ProjectIdentity): string[] {
    return this.#sourceReferences(identity.source).map((source) => {
      const module = this.#graph.sourceToBuild
        .get(identity.checker)
        ?.get(source);
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
    return this.#sourceReferences(identity.source).flatMap((source) =>
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
  #entryMember(checker: string, entry: [string, string]): string[] {
    const [source, owner] = entry;
    if (owner !== checker) return [];
    const module = this.#build({ checker, source });
    return module === undefined ? [] : [module.path];
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
  assertBound(): void {
    this.#assertLeaves();
    this.#assertSolutions();
    this.#assertOutputSolutions();
    for (const [checker, entry] of this.#graph.checkerEntries) {
      const expected = [
        ...this.#graph.ownershipPlan.entryOwnerByConfigPath,
      ].flatMap((member) => this.#entryMember(checker, member));
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
