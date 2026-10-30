import type { DeclarationCandidateObservation } from '../declaration-governance/candidate';
import { DeclarationObservationUnavailable } from '../declaration-governance/candidate';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import type { GeneratedDependencyEdge } from './types';

interface ReferenceInput {
  file: string;
  provider: string;
}

/** Obligations are admitted separately. Every emitted implementation relation
 * must additionally work at the compiler's lexical reference-map boundary. */
export function implementationReferenceInputs(
  edges: readonly GeneratedDependencyEdge[],
): Map<string, ReferenceInput[]> {
  const inputs = new Map<string, ReferenceInput[]>();
  for (const edge of edges) {
    if (
      edge.kind !== 'declaration-provider' ||
      isDeclarationFile(edge.resolvedFilePath)
    )
      continue;
    const entries = inputs.get(edge.fromConfigPath) ?? [];
    if (
      entries.every(
        (entry) =>
          entry.file !== edge.resolvedFilePath ||
          entry.provider !== edge.toConfigPath,
      )
    )
      entries.push({
        file: edge.resolvedFilePath,
        provider: edge.toConfigPath,
      });
    inputs.set(edge.fromConfigPath, entries);
  }
  return inputs;
}

export function validateImplementationMappings(
  inputs: readonly ReferenceInput[],
  closure: readonly { sourceConfig: string; generatedConfig: string }[],
  observation: DeclarationCandidateObservation,
): void {
  for (const input of inputs) {
    const provider = closure.find(
      (project) => project.sourceConfig === input.provider,
    );
    const mapping = observation.mappings.find(
      (item) => item.file === input.file,
    );
    if (
      !provider ||
      !mapping?.qualified ||
      mapping.referenceConfig !== provider.generatedConfig ||
      mapping.declarationOutput === null
    )
      throw new DeclarationObservationUnavailable(
        `Required compilation input is not covered by the compiler reference mapping: ${input.file}; provider: ${input.provider}; actual reference: ${mapping?.referenceConfig ?? 'unproved'}.`,
      );
  }
}
