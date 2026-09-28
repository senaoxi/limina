import type { ValidationContext } from '../domain/validation/contracts';
import type {
  DeclarationBuildValidationView,
  OutputBuildValidationView,
  PackageArtifactValidationView,
  ProjectValidationView,
  SourceDependencyValidationView,
  WorkspaceValidationView,
} from '../domain/validation/views';

interface FutureArchitecturePolicy {
  inspectDeclarationBuild?(
    view: DeclarationBuildValidationView,
    context: ValidationContext<string>,
  ): Promise<void> | void;
  inspectOutputBuild?(
    view: OutputBuildValidationView,
    context: ValidationContext<string>,
  ): Promise<void> | void;
  inspectPackageArtifacts?(
    view: PackageArtifactValidationView,
    context: ValidationContext<string>,
  ): Promise<void> | void;
  inspectProjects?(
    view: ProjectValidationView,
    context: ValidationContext<string>,
  ): Promise<void> | void;
  inspectSourceDependencies?(
    view: SourceDependencyValidationView,
    context: ValidationContext<string>,
  ): Promise<void> | void;
  inspectWorkspace?(
    view: WorkspaceValidationView,
    context: ValidationContext<string>,
  ): Promise<void> | void;
}

const hookKinds = {
  inspectDeclarationBuild: 'declaration-build',
  inspectOutputBuild: 'output-build',
  inspectPackageArtifacts: 'package-artifacts',
  inspectProjects: 'projects',
  inspectSourceDependencies: 'source-dependencies',
  inspectWorkspace: 'workspace',
} as const satisfies Record<keyof FutureArchitecturePolicy, string>;

describe('future architecture extension compatibility', () => {
  it('maps the six stable semantic hooks to existing planner input kinds', () => {
    expect(Object.values(hookKinds).sort()).toEqual([
      'declaration-build',
      'output-build',
      'package-artifacts',
      'projects',
      'source-dependencies',
      'workspace',
    ]);
    expect(hookKinds).not.toHaveProperty('inspectImportFacts');
  });
});
