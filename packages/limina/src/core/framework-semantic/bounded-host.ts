import type ts from 'typescript';
import { TypeScriptInclusionLedger } from '../typescript-semantic/admission';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import { nativeTypeReferenceMode } from '../typescript-semantic/native-program-api';
import { prepareTypeScriptSupportInputs } from '../typescript-semantic/support-inputs';

type ModuleResolver = NonNullable<
  ts.LanguageServiceHost['resolveModuleNameLiterals']
>;
interface SourceOptionsReceipt {
  source: ts.SourceFile;
  options: ts.CompilerOptions;
  redirect: ts.ResolvedProjectReference | undefined;
}
interface HostOptions {
  host: ts.LanguageServiceHost;
  project: TypeScriptSemanticProject;
  tsModule: typeof ts;
  observeOptions?: (input: SourceOptionsReceipt) => void;
  observeType?: (input: {
    source: ts.SourceFile | undefined;
    reference: ts.FileReference | string;
    options: ts.CompilerOptions;
    redirect: ts.ResolvedProjectReference | undefined;
    mode: ts.ResolutionMode;
    result: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations;
  }) => void;
  observeModule?: (
    input: SourceOptionsReceipt & {
      literal: ts.StringLiteralLike;
      result: ts.ResolvedModuleWithFailedLookupLocations;
    },
  ) => void;
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
            redirect: arguments_[2],
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
  observe: HostOptions['observeOptions'],
  observeType: HostOptions['observeType'],
  compiler: typeof ts,
): void {
  if (raw.resolveTypeReferenceDirectiveReferences === undefined) {
    if (observeType === undefined) return;
    if (raw.resolveTypeReferenceDirectives !== undefined)
      throw new Error('Unqualified legacy type-directive resolver.');
  }
  // Volar has no custom type-directive resolver in some supported tuples.
  // Install the compiler's own default at the same host boundary so automatic
  // requests are observed before snapshots are withheld, too.
  const resolve =
    raw.resolveTypeReferenceDirectiveReferences?.bind(raw) ??
    defaultTypeResolver(raw, compiler);
  host.resolveTypeReferenceDirectiveReferences = (...arguments_) => {
    const source = arguments_[4];
    if (source !== undefined)
      observe?.({ source, options: arguments_[3], redirect: arguments_[2] });
    const results = resolve(...arguments_);
    for (const [index, result] of results.entries()) {
      observeType?.({
        source,
        reference: arguments_[0][index]!,
        options: arguments_[3],
        redirect: arguments_[2],
        mode: nativeTypeReferenceMode(
          compiler,
          arguments_[0][index]!,
          source,
          arguments_[2]?.commandLine.options ?? arguments_[3],
        ),
        result,
      });
      admitResolvedType(admission, result);
    }
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
  installTypeResolver(
    raw,
    host,
    admission,
    options.observeOptions,
    options.observeType,
    tsModule,
  );
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

function defaultTypeResolver(
  raw: ts.LanguageServiceHost,
  compiler: typeof ts,
): NonNullable<
  ts.LanguageServiceHost['resolveTypeReferenceDirectiveReferences']
> {
  const cache = compiler.createTypeReferenceDirectiveResolutionCache(
    raw.getCurrentDirectory(),
    (file) =>
      compiler.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(),
  );
  return (references, file, redirect, options, source) =>
    references.map((reference) =>
      compiler.resolveTypeReferenceDirective(
        typeof reference === 'string' ? reference : reference.fileName,
        file,
        options,
        raw,
        redirect,
        cache,
        nativeTypeReferenceMode(
          compiler,
          reference,
          source,
          redirect?.commandLine.options ?? options,
        ),
      ),
    );
}
