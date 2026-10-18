import path from 'node:path';
import type ts from 'typescript';
import { collectTypeScriptSourceFileImports } from '../import-analysis/typescript-imports';
import type { TypeScriptInclusionLedger } from './admission';
import type { TypeScriptSemanticProject } from './contracts';
import { getStandaloneModuleLocation } from './module-records';
import { requestEligibility } from './request-eligibility';

interface SupportInputOptions {
  admission: TypeScriptInclusionLedger;
  host: ts.ModuleResolutionHost;
  project: TypeScriptSemanticProject;
  tsModule: typeof ts;
  resolveModules?: (
    file: ts.SourceFile,
    literals: ts.StringLiteralLike[],
  ) => readonly ts.ResolvedModuleWithFailedLookupLocations[];
}
function admitTypeReference(
  options: SupportInputOptions,
  result: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations,
): void {
  const target = result.resolvedTypeReferenceDirective?.resolvedFileName;
  if (target !== undefined) options.admission.addTypeReference(target);
}
function seedTypeEnvironment(options: SupportInputOptions): void {
  const { admission, host, project, tsModule } = options;
  const containingFile = path.join(
    path.dirname(project.configPath),
    '__inferred type names__.ts',
  );
  const names = tsModule.getAutomaticTypeDirectiveNames(project.options, host);
  for (const name of names) {
    admitTypeReference(
      options,
      tsModule.resolveTypeReferenceDirective(
        name,
        containingFile,
        project.options,
        host,
      ),
    );
  }
  if (!project.options.noLib)
    admission.addDefaultLib(tsModule.getDefaultLibFilePath(project.options));
}
function readSupportSource(
  options: SupportInputOptions,
  fileName: string,
): ts.SourceFile | undefined {
  const { project, host, tsModule } = options;
  const text = supportText(options, fileName);
  return text === undefined
    ? undefined
    : tsModule.createSourceFile(
        fileName,
        text,
        {
          languageVersion: supportLanguageTarget(options),
          impliedNodeFormat: tsModule.getImpliedNodeFormatForFile(
            fileName as ts.Path,
            undefined,
            host,
            project.options,
          ),
        },
        true,
      );
}
function admitPathAndLibraryReferences(
  options: SupportInputOptions,
  file: ts.SourceFile,
): void {
  for (const reference of file.referencedFiles) {
    options.admission.addExplicitReference(
      options.tsModule.resolveTripleslashReference(
        reference.fileName,
        file.fileName,
      ),
    );
  }
  for (const reference of file.libReferenceDirectives)
    options.admission.addLibReference(reference.fileName);
}
function admitTypeReferences(
  options: SupportInputOptions,
  file: ts.SourceFile,
): void {
  for (const reference of file.typeReferenceDirectives) {
    admitTypeReference(
      options,
      options.tsModule.resolveTypeReferenceDirective(
        reference.fileName,
        file.fileName,
        options.project.options,
        options.host,
        undefined,
        undefined,
        reference.resolutionMode ?? file.impliedNodeFormat,
      ),
    );
  }
}
function moduleLiterals(
  options: SupportInputOptions,
  file: ts.SourceFile,
): ts.StringLiteralLike[] {
  return collectTypeScriptSourceFileImports({
    filePath: file.fileName,
    sourceFile: file,
    tsModule: options.tsModule,
  }).flatMap((importRecord) => {
    if (!requestEligibility(file, importRecord, options.tsModule).expansion)
      return [];
    const location = getStandaloneModuleLocation({
      importRecord,
      getSourceFile: () => file,
      tsModule: options.tsModule,
    });
    return location === null ? [] : [location.literal];
  });
}
function resolveModules(
  options: SupportInputOptions,
  file: ts.SourceFile,
): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
  const literals = moduleLiterals(options, file);
  return options.resolveModules === undefined
    ? literals.map((literal) =>
        options.tsModule.resolveModuleName(
          literal.text,
          file.fileName,
          options.project.options,
          options.host,
          undefined,
          undefined,
          options.tsModule.getModeForUsageLocation(
            file,
            literal,
            options.project.options,
          ),
        ),
      )
    : options.resolveModules(file, literals);
}
function admitModuleTargets(
  options: SupportInputOptions,
  file: ts.SourceFile,
): void {
  for (const result of resolveModules(options, file)) {
    if (result.resolvedModule !== undefined)
      options.admission.allowModuleTarget(result.resolvedModule, file.fileName);
  }
}
function expandSupportInput(
  options: SupportInputOptions,
  fileName: string,
): void {
  const file = readSupportSource(options, fileName);
  if (file === undefined) return;
  if (options.project.options.noResolve) {
    admitLibraries(options, file);
  } else {
    admitPathAndLibraryReferences(options, file);
    admitTypeReferences(options, file);
    admitModuleTargets(options, file);
  }
}
function admitLibraries(
  options: SupportInputOptions,
  file: ts.SourceFile,
): void {
  if (options.project.options.noLib) return;
  for (const reference of file.libReferenceDirectives)
    options.admission.addLibReference(reference.fileName);
}

function expandPendingInputs(
  options: SupportInputOptions,
  pending: string[],
  processed: Map<string, boolean>,
): void {
  for (const fileName of pending) {
    const isSupport = options.admission.isSupportInput(fileName);
    if (processed.get(fileName) === isSupport) continue;
    processed.set(fileName, isSupport);
    expandSupportInput(options, fileName);
  }
}
/**
 * A finite worklist of legally admitted inputs, without expanding root ownership.
 */
export function prepareTypeScriptSupportInputs(
  options: SupportInputOptions,
): void {
  if (options.project.admissionMode === 'root-facts') return;
  seedTypeEnvironment(options);
  const processed = new Map<string, boolean>();
  for (
    let pending = options.admission.takePendingInputs();
    pending.length > 0;
    pending = options.admission.takePendingInputs()
  ) {
    expandPendingInputs(options, pending, processed);
  }
}

function supportText(
  options: SupportInputOptions,
  fileName: string,
): string | undefined {
  return (
    options.project.virtualFiles?.get(fileName) ??
    options.host.readFile(fileName)
  );
}
function supportLanguageTarget(options: SupportInputOptions): ts.ScriptTarget {
  return options.project.options.target ?? options.tsModule.ScriptTarget.Latest;
}
