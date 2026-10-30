import ts from 'typescript';
import { compilerFileKey } from '../typescript-semantic/compiler-coverage';
import type {
  DeclarationCandidateInput,
  DeclarationCandidateObservation,
} from './candidate';

/** Qualified against TypeScript 6.0.3's config-driven Reference Map. Other
 * toolchains/inputs use the real candidate Program; no output is read here. */
export function proveNativeImplementationMappings(
  input: DeclarationCandidateInput,
): DeclarationCandidateObservation['mappings'] | undefined {
  const projects = input.referenceProjects;
  if (
    projects === undefined ||
    ts.version !== '6.0.3' ||
    projects.some(
      (project) => !['tsc', 'tsgo'].includes(project.preset ?? project.checker),
    )
  )
    return undefined;
  const referenced = projects.filter(
    (project) => project.generatedConfig !== input.generatedConfig,
  );
  const mappings: DeclarationCandidateObservation['mappings'][number][] = [];
  const inputs = input.referenceInputs ?? [];
  for (const file of inputs) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) return undefined;
    const matches = referenced.flatMap((project) =>
      project.parsed.fileNames
        .filter((member) => compilerFileKey(member) === compilerFileKey(file))
        .map((member) => ({ project, member })),
    );
    // Overlap and adapter-specific output rules need actual compiler observation.
    if (matches.length !== 1) return undefined;
    const { project, member } = matches[0]!;
    const options = project.parsed.options;
    if (
      !options.composite ||
      options.noEmit ||
      options.declaration === false ||
      options.outFile
    )
      return undefined;
    const output = ts
      .getOutputFileNames(
        project.parsed,
        member,
        !ts.sys.useCaseSensitiveFileNames,
      )
      .find((name) => name.endsWith('.d.ts'));
    if (output === undefined) return undefined;
    mappings.push({
      file,
      referenceConfig: project.generatedConfig,
      declarationOutput: output,
      qualified: true,
    });
  }
  return mappings;
}
