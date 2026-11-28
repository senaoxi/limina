import { getCheckerSemanticFamily } from '../build-graph/checker-semantic-authority';
import type { ProjectInfo } from '../import-graph/context';
import type {
  ProjectDependency,
  ProjectDependencyCollection,
  ProjectDependencyObservation,
} from '../project-dependencies/contracts';
import type { TypeEvidenceCore } from '../type-evidence';
import type { WorkspaceLookupIndex } from '../workspace/lookup';
import {
  type PhysicalResourceEvidence,
  ResourceResolver,
} from './resource-resolver';

export type ResourceProjectImport =
  | ProjectDependency
  | Exclude<ProjectDependencyObservation, { kind: 'unmapped-generated' }>;

export interface ResourceImportFact {
  readonly checkerName: string;
  readonly physical: PhysicalResourceEvidence;
}

export type ResourceProjectFacts = ReadonlyMap<
  ResourceProjectImport,
  readonly ResourceImportFact[]
>;

export interface ResourceProjectFactRequest {
  readonly checkerNames: readonly string[];
  readonly collection: ProjectDependencyCollection;
  readonly project: ProjectInfo;
  readonly typeEvidence: TypeEvidenceCore;
}

export class ResourceFactCollector {
  readonly #workspaceLookup: WorkspaceLookupIndex;
  readonly #resolver: ResourceResolver;

  constructor(workspaceLookup: WorkspaceLookupIndex) {
    this.#workspaceLookup = workspaceLookup;
    this.#resolver = new ResourceResolver(
      (manifestPath) =>
        workspaceLookup.findNearestPackageScopeInfo(manifestPath)?.manifest,
    );
  }

  #collectImport(
    request: ResourceProjectFactRequest,
    dependency: ResourceProjectImport,
  ): readonly ResourceImportFact[] | undefined {
    let facts: ResourceImportFact[] | undefined;
    const { project, typeEvidence } = request;
    const { evidence, importRecord, resolutionMode } = dependency;
    const [checkerPreset] = project.checkerPresets;
    const evidenceChecker =
      checkerPreset !== undefined &&
      project.checkerPresets.length === 1 &&
      getCheckerSemanticFamily(checkerPreset) ===
        evidence.context.authority.family
        ? checkerPreset
        : undefined;
    for (const checkerName of request.checkerNames) {
      const runtimeEvidence =
        (checkerName === evidenceChecker ? evidence.runtime : undefined) ??
        typeEvidence.classifyImportRuntime({
          checkerName,
          importRecord,
          project,
          resolutionMode: 'checker-only',
        });
      if (
        runtimeEvidence.classification !== 'resource' ||
        runtimeEvidence.runtime.kind === 'asserted-virtual' ||
        runtimeEvidence.runtime.kind === 'unsupported'
      ) {
        continue;
      }
      (facts ??= []).push(
        Object.freeze({
          checkerName,
          physical: this.#resolver.resolve({
            importRecord,
            options: project.options,
            resolutionMode,
          }),
        }),
      );
    }
    return facts === undefined ? undefined : Object.freeze(facts);
  }

  collect(request: ResourceProjectFactRequest): ResourceProjectFacts {
    const facts = new Map<
      ResourceProjectImport,
      readonly ResourceImportFact[]
    >();
    if (request.checkerNames.length === 0) return facts;
    const { dependencies, observations } = request.collection;
    for (const imports of [dependencies, observations]) {
      for (const dependency of imports) {
        if (
          !('importRecord' in dependency) ||
          this.#workspaceLookup.findOwnerForFile(
            dependency.importRecord.filePath,
          ) === null
        ) {
          continue;
        }
        const resources = this.#collectImport(request, dependency);
        if (resources !== undefined) facts.set(dependency, resources);
      }
    }
    return facts;
  }

  dispose(): void {
    this.#resolver.dispose();
  }
}
