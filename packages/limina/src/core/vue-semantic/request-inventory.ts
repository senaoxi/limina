import type ts from 'typescript';
import type {
  CheckerRequestInventory,
  DeclarationRequestReceipt,
} from '../../domain/analysis/declaration-governance';
import { isDeclarationFile } from '../import-graph/declaration-classifier';
import { effectiveCompilerOptions } from '../typescript-semantic/compiler-options';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';
import { selectNativePath } from '../typescript-semantic/native-path-selection';
import {
  nativeObservedProgram,
  nativeProgramSource,
  nativeTypeReferenceMode,
} from '../typescript-semantic/native-program-api';
import {
  observeNativeReference,
  observeReferenceCompilerOptions,
} from '../typescript-semantic/reference-redirect';
import type { VueSemanticContext } from './context';

/** Inventory comes from the Volar Program, not a second module resolver or a
 * source-text walk. Raw callback receipts survive the bounded host's masking. */
export function collectVueRequestInventory(
  context: VueSemanticContext,
): CheckerRequestInventory {
  const { compilerRequests: collector, tsModule: compiler } = context;
  const program = nativeObservedProgram(
    context.program,
    compiler,
    collector.optionsBySource,
  );
  const requests: DeclarationRequestReceipt[] = [];
  for (const root of program.getRootFileNames()) {
    if (!isDeclarationFile(root)) continue;
    requests.push({
      file: root,
      position: -1,
      channel: 'root',
      specifier: root,
      mode: null,
      target: root,
      resolutionState:
        program.getSourceFile(root) === undefined ? 'unavailable' : 'resolved',
      redirects: [],
      environment: effectiveCompilerOptions(program.getCompilerOptions()),
      externalLibrary: null,
    });
  }
  for (const source of program.getSourceFiles()) {
    const options = program.getCompilerOptionsForFile(source);
    const environment = effectiveCompilerOptions(
      options ?? program.getCompilerOptions(),
    );
    for (const request of collector.collect(program, source)) {
      const callback = collector.moduleResolutions.findLast(
        (item) => item.source === source && item.literal === request.literal,
      );
      const raw = request.raw;
      const target = raw?.resolvedModule;
      requests.push({
        file: source.fileName,
        position: request.literal.pos,
        channel:
          request.role === 'augmentation'
            ? 'augmentation'
            : request.literal.pos < 0
              ? 'implicit'
              : 'module',
        specifier: request.literal.text,
        mode: modeName(request.mode),
        target: target?.resolvedFileName ?? null,
        resolutionState:
          target === undefined &&
          nativeProgramSource(source).ambientModuleNames.includes(
            request.literal.text,
          )
            ? 'ambient'
            : raw === undefined && options?.noResolve
              ? 'suppressed'
              : options === undefined || raw === undefined
                ? 'unavailable'
                : target === undefined
                  ? 'unresolved'
                  : 'resolved',
        redirects: redirects(callback?.redirect),
        environment,
        externalLibrary: target?.isExternalLibraryImport ?? null,
      });
    }
    for (const reference of source.typeReferenceDirectives) {
      const typeOptions =
        options ??
        (program.getCompilerOptions().noResolve
          ? observeReferenceCompilerOptions(program, source.fileName, compiler)
          : undefined);
      const mode = nativeTypeReferenceMode(
        compiler,
        reference,
        source,
        typeOptions,
      );
      const callback = collector.typeResolutions.findLast(
        (item) =>
          item.source === source &&
          typeof item.reference !== 'string' &&
          item.reference.pos === reference.pos,
      );
      const raw =
        callback?.result ??
        program.getResolvedTypeReferenceDirective(
          source,
          reference.fileName,
          mode,
        );
      requests.push(
        typeReceipt(
          source.fileName,
          reference.pos,
          reference.fileName,
          mode,
          raw,
          callback?.redirect,
          typeOptions,
          program.getCompilerOptions().noResolve === true,
        ),
      );
    }
    for (const reference of source.referencedFiles) {
      const selection = selectNativePath({
        compiler,
        source,
        reference,
        options: program.getCompilerOptions(),
        host: {
          fileExists: context.sys.fileExists,
          getCanonicalFileName: (file) =>
            compiler.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(),
        },
        redirect: (file) => {
          const observed = observeNativeReference(program, file, compiler);
          return observed.state === 'observed' ? observed.redirect : null;
        },
      });
      requests.push({
        file: source.fileName,
        position: reference.pos,
        channel: 'path-directive',
        specifier: reference.fileName,
        mode: null,
        target: selection?.selection.logicalTarget ?? null,
        resolutionState:
          selection?.selection.state === 'disabled'
            ? 'suppressed'
            : selection === undefined ||
                selection.selection.state === 'unavailable'
              ? 'unavailable'
              : selection.selection.logicalTarget === null
                ? 'unresolved'
                : 'resolved',
        redirects: selection?.redirect
          ? [selection.redirect.referenceConfig]
          : [],
        environment: effectiveCompilerOptions(program.getCompilerOptions()),
        externalLibrary: null,
      });
    }
    for (const reference of source.libReferenceDirectives) {
      const library = (
        compiler as typeof compiler & { libMap: Map<string, string> }
      ).libMap?.get(reference.fileName.toLowerCase());
      const target =
        library === undefined
          ? undefined
          : program.resolvedLibReferences?.get(library)?.actual;
      requests.push({
        file: source.fileName,
        position: reference.pos,
        channel: 'library',
        specifier: reference.fileName,
        mode: null,
        target: target ?? null,
        resolutionState: program.getCompilerOptions().noLib
          ? 'suppressed'
          : target === undefined
            ? 'unresolved'
            : 'resolved',
        redirects: [],
        environment: effectiveCompilerOptions(program.getCompilerOptions()),
        externalLibrary: null,
      });
    }
  }
  // Automatic type requests have no containing SourceFile. Only actual host
  // callbacks authorize consumption; discovered package names are not requests.
  for (const callback of collector.typeResolutions) {
    if (callback.source !== undefined) continue;
    const reference = callback.reference;
    requests.push(
      typeReceipt(
        context.identity.configPath,
        -1,
        typeof reference === 'string' ? reference : reference.fileName,
        callback.mode,
        callback.result,
        callback.redirect,
        callback.redirect?.commandLine.options ?? callback.options,
      ),
    );
  }
  const libraries = program.resolvedLibReferences ?? new Map();
  for (const [name, library] of libraries)
    requests.push({
      file: context.identity.configPath,
      position: -1,
      channel: 'library',
      specifier: name,
      mode: null,
      target: library.actual,
      resolutionState: 'resolved',
      redirects: [],
      environment: effectiveCompilerOptions(program.getCompilerOptions()),
      externalLibrary: null,
    });
  const unique = new Map(
    requests.map((request) => [nativeFingerprint(request), request]),
  )
    .values()
    .toArray();
  return {
    requests: unique,
    complete: unique.every(
      (request) => request.resolutionState !== 'unavailable',
    ),
  };
}
function modeName(mode: ts.ResolutionMode): string | null {
  return mode === undefined ? null : String(mode);
}
function redirects(
  reference: ts.ResolvedProjectReference | undefined,
): string[] {
  return reference === undefined ? [] : [reference.sourceFile.fileName];
}
function typeReceipt(
  file: string,
  position: number,
  specifier: string,
  mode: ts.ResolutionMode,
  raw: ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations | undefined,
  redirect: ts.ResolvedProjectReference | undefined,
  options: ts.CompilerOptions | undefined,
  isSuppressed = false,
): DeclarationRequestReceipt {
  const target = raw?.resolvedTypeReferenceDirective;
  return {
    file,
    position,
    channel: 'type-directive',
    specifier,
    mode: modeName(mode),
    target: target?.resolvedFileName ?? null,
    resolutionState:
      isSuppressed && raw === undefined && options !== undefined
        ? 'suppressed'
        : options === undefined || raw === undefined
          ? 'unavailable'
          : target === undefined
            ? 'unresolved'
            : 'resolved',
    redirects: redirects(redirect),
    environment: effectiveCompilerOptions(options ?? {}),
    externalLibrary: target?.isExternalLibraryImport ?? null,
  };
}
