import type ts from 'typescript';
import { TypeScriptInclusionLedger } from '../typescript-semantic/admission';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { prepareTypeScriptSupportInputs } from '../typescript-semantic/support-inputs';

type ModuleResolver = NonNullable<
  ts.LanguageServiceHost['resolveModuleNameLiterals']
>;
interface HostOptions {
  host: ts.LanguageServiceHost;
  project: TypeScriptSemanticProject;
  tsModule: typeof ts;
  observeModule?: (input: {
    source: ts.SourceFile;
    literal: ts.StringLiteralLike;
    options: ts.CompilerOptions;
    result: ts.ResolvedModuleWithFailedLookupLocations;
  }) => void;
}
interface BoundedHost {
  host: ts.LanguageServiceHost;
  begin(): void;
  needsRebuild(): boolean;
}
function readHostFile(
  host: ts.LanguageServiceHost,
  file: string,
): string | undefined {
  const snapshot = host.getScriptSnapshot(file);
  return snapshot === undefined
    ? host.readFile?.(file)
    : snapshot.getText(0, snapshot.getLength());
}
function optionalHostMethods(host: ts.LanguageServiceHost) {
  return {
    directoryExists: host.directoryExists?.bind(host),
    getDirectories: host.getDirectories?.bind(host),
  };
}
function createResolutionHost({
  host,
  tsModule,
}: HostOptions): ts.ModuleResolutionHost {
  return {
    fileExists: (file) =>
      host.fileExists?.(file) ?? tsModule.sys.fileExists(file),
    readFile: (file) => readHostFile(host, file),
    ...optionalHostMethods(host),
    realpath: host.realpath?.bind(host),
    getCurrentDirectory: host.getCurrentDirectory.bind(host),
  };
}
function seedCheckerInputs(
  options: HostOptions,
  admission: TypeScriptInclusionLedger,
): void {
  for (const file of options.host.getScriptFileNames()) {
    if (!options.project.fileNames.includes(file))
      admission.addTypeReference(file);
  }
}
function maskModuleResult(options: {
  admission: TypeScriptInclusionLedger;
  result: ts.ResolvedModuleWithFailedLookupLocations;
  containingFile: string;
}): ts.ResolvedModuleWithFailedLookupLocations {
  const target = options.result.resolvedModule;
  if (
    target === undefined ||
    options.admission.allowModuleTarget(target, options.containingFile)
  )
    return options.result;
  options.admission.exclude(target.resolvedFileName);
  return { ...options.result, resolvedModule: undefined };
}
function wrapModuleResolver(
  resolver: ModuleResolver | undefined,
  admission: TypeScriptInclusionLedger,
  observe: HostOptions['observeModule'],
): ModuleResolver | undefined {
  return resolver === undefined
    ? undefined
    : (...arguments_) =>
        resolver(...arguments_).map((result, index) => {
          observe?.({
            source: arguments_[4],
            literal: arguments_[0][index]!,
            options: arguments_[3],
            result,
          });
          return maskModuleResult({
            admission,
            result,
            containingFile: arguments_[1],
          });
        });
}
function admitResolvedType(
  admission: TypeScriptInclusionLedger,
  result: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations,
): void {
  const target = result.resolvedTypeReferenceDirective?.resolvedFileName;
  if (target !== undefined) admission.addTypeReference(target);
}
function installTypeResolver(
  raw: ts.LanguageServiceHost,
  host: ts.LanguageServiceHost,
  admission: TypeScriptInclusionLedger,
): void {
  const resolve = raw.resolveTypeReferenceDirectiveReferences?.bind(raw);
  if (resolve === undefined) return;
  host.resolveTypeReferenceDirectiveReferences = (...arguments_) => {
    const results = resolve(...arguments_);
    for (const result of results) admitResolvedType(admission, result);
    return results;
  };
}
function readAdmittedSnapshot(
  raw: ts.LanguageServiceHost,
  admission: TypeScriptInclusionLedger,
  file: string,
): ts.IScriptSnapshot | undefined {
  if (admission.has(file) || admission.allowDefaultLib(file))
    return raw.getScriptSnapshot(file);
  admission.exclude(file);
  return undefined;
}
function prepareInputs(
  options: HostOptions,
  admission: TypeScriptInclusionLedger,
  resolver: ModuleResolver | undefined,
): void {
  prepareTypeScriptSupportInputs({
    admission,
    host: createResolutionHost(options),
    project: options.project,
    tsModule: options.tsModule,
    resolveModules:
      resolver === undefined
        ? undefined
        : (file, literals) =>
            resolver(
              literals,
              file.fileName,
              undefined,
              options.project.options,
              file,
              undefined,
            ),
  });
}
/**
 * Only the Program sees this admission facade; resolution retains the checker host.
 */
export function createBoundedLanguageServiceHost(
  options: HostOptions,
): BoundedHost {
  const { host: raw, project, tsModule } = options;
  const admission = new TypeScriptInclusionLedger(project, tsModule);
  const host: ts.LanguageServiceHost = Object.create(raw);
  const resolver = raw.resolveModuleNameLiterals?.bind(raw);
  host.getScriptSnapshot = (file) => readAdmittedSnapshot(raw, admission, file);
  host.resolveModuleNameLiterals = wrapModuleResolver(
    resolver,
    admission,
    options.observeModule,
  );
  installTypeResolver(raw, host, admission);
  return {
    host,
    begin: () => {
      seedCheckerInputs(options, admission);
      prepareInputs(options, admission, resolver);
      admission.beginProgram();
    },
    needsRebuild: () => {
      prepareInputs(options, admission, resolver);
      return admission.needsProgramRebuild();
    },
  };
}
