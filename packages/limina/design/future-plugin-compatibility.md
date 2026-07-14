# Future Plugin Compatibility

0.2.0 does not implement a plugin config field, loader, API package, hook bus, runtime, or extension context. It only ensures built-in rules obey the same read-only validation contract intended for a later architecture policy product.

The first future public surface selects six semantic hooks:

```ts
interface FutureArchitecturePolicy {
  inspectWorkspace?(
    view: WorkspaceValidationView,
    context: ValidationContext,
  ): void | Promise<void>;
  inspectProjects?(view: ProjectValidationView, context: ValidationContext): void | Promise<void>;
  inspectSourceDependencies?(
    view: SourceDependencyValidationView,
    context: ValidationContext,
  ): void | Promise<void>;
  inspectDeclarationBuild?(
    view: DeclarationBuildValidationView,
    context: ValidationContext,
  ): void | Promise<void>;
  inspectOutputBuild?(
    view: OutputBuildValidationView,
    context: ValidationContext,
  ): void | Promise<void>;
  inspectPackageArtifacts?(
    view: PackageArtifactValidationView,
    context: ValidationContext,
  ): void | Promise<void>;
}
```

A future adapter converts each declared hook into the existing typed registration form. Built-in and adapted registrations are merged as planner input; the planner algorithm and fixed stage dependency model do not change.

Trusted same-process code can receive a signal, duration measurement, slow warning, rejection capture, and failure attribution. It cannot be forced to stop a synchronous infinite loop. Hard timeout and resource enforcement require worker or process isolation and remain a separate future decision.
