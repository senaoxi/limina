import path from 'node:path';
import type ts from 'typescript';
import { nativeLibraryFileName } from './native-library-api';
import {
  nativeCompilerApi,
  type NativeObservedProgram,
  nativeProgramSource,
} from './native-program-api';
import type { NativeProgramFrontier } from './native-program-frontier';
import {
  moduleChannel,
  type NativeModuleObservation,
  type NativeProgramRequests,
} from './native-program-requests';

interface Inventory {
  program: NativeObservedProgram;
  compiler: typeof ts;
  requests: NativeProgramRequests;
  frontier: NativeProgramFrontier;
}

function collectModule(
  options: Inventory,
  observation: Omit<NativeModuleObservation, 'requestId' | 'mode' | 'raw'>,
): NativeModuleObservation {
  const { source, literal } = observation;
  const mode = options.program.getModeForUsageLocation(source, literal);
  const raw = options.program.getResolvedModule(source, literal.text, mode);
  const requestId = options.requests.record({
    source,
    position: literal.pos,
    channel: moduleChannel(literal),
    name: literal.text,
    mode,
    ...moduleResolution(raw),
    ambient: nativeProgramSource(source).ambientModuleNames.includes(
      literal.text,
    ),
  });
  return { ...observation, requestId, mode, raw };
}

function moduleResolution(
  raw: ts.ResolvedModuleWithFailedLookupLocations | undefined,
) {
  const target = raw?.resolvedModule;
  return { ...moduleTarget(target), unavailable: raw === undefined };
}

function moduleTarget(target: ts.ResolvedModuleFull | undefined) {
  return {
    target: target?.resolvedFileName,
    external: target?.isExternalLibraryImport,
  };
}

function collectSourceModules(options: Inventory, source: ts.SourceFile) {
  const inventory = nativeProgramSource(source);
  const imports = inventory.imports.map((literal) =>
    collectModule(options, {
      source,
      literal,
      role: 'import',
    }),
  );
  const augmentations = inventory.moduleAugmentations.filter(
    options.compiler.isStringLiteral,
  );
  return [
    ...imports,
    ...augmentations.map((literal) =>
      collectModule(options, {
        source,
        literal,
        role: 'augmentation',
      }),
    ),
  ];
}

function collectPath(
  options: Inventory,
  source: ts.SourceFile,
  reference: ts.FileReference,
) {
  // Path observations were pinned before loading. A bounded Program lookup can
  // return a lower-priority file that belongs to a different legitimate entry.
  const isExists = options.requests.entries.some(({ request }) => {
    if (request.entry.kind !== 'source') return false;
    return [
      request.channel === 'path-directive',
      request.sourceFile?.lexicalPath === source.fileName,
      request.entry.position === reference.pos,
    ].every(Boolean);
  });
  if (!isExists)
    options.requests.record({
      source,
      position: reference.pos,
      channel: 'path-directive',
      name: reference.fileName,
      unavailable: true,
    });
}

function collectType(
  options: Inventory,
  source: ts.SourceFile,
  reference: ts.FileReference,
) {
  const mode = nativeCompilerApi(options.compiler).getModeForFileReference(
    reference,
    source.impliedNodeFormat,
  );
  options.requests.typeCallback({
    reference,
    source,
    mode,
    raw: options.program.getResolvedTypeReferenceDirective(
      source,
      reference.fileName,
      mode,
    ),
    redirect: undefined,
  });
}

function collectSourceDirectives(options: Inventory, source: ts.SourceFile) {
  const channels = [
    { references: source.referencedFiles, collect: collectPath },
    { references: source.typeReferenceDirectives, collect: collectType },
    { references: source.libReferenceDirectives, collect: collectLibrary },
  ];
  for (const channel of channels)
    for (const reference of channel.references)
      channel.collect(options, source, reference);
}

function collectLibrary(
  options: Inventory,
  source: ts.SourceFile,
  reference: ts.FileReference,
) {
  const libraryName = nativeLibraryFileName(options.compiler, reference);
  const target =
    libraryName === undefined
      ? undefined
      : resolvedLibrary(options.program, libraryName);
  options.requests.record({
    source,
    position: reference.pos,
    channel: 'library',
    name: reference.fileName,
    target,
    // Library inclusion is controlled by the consumer Program, independently
    // of per-source module resolution options in referenced declarations.
    unavailable: options.program.getCompilerOptions().noLib,
  });
}

function resolvedLibrary(program: NativeObservedProgram, name: string) {
  return program.resolvedLibReferences?.get(name)?.actual;
}

export function collectNativeProgramInventory(
  options: Inventory,
): NativeModuleObservation[] {
  const modules: NativeModuleObservation[] = [];
  for (const source of options.program.getSourceFiles()) {
    assertSourceFrontier(options.frontier, source.fileName);
    modules.push(...collectSourceModules(options, source));
    collectSourceDirectives(options, source);
  }
  collectLibraries(options);
  return modules;
}

function collectLibraries(options: Inventory): void {
  const libraries = options.program.resolvedLibReferences ?? new Map();
  for (const [name, library] of libraries)
    options.requests.record({
      position: -1,
      channel: 'library',
      name,
      target: library.actual,
    });
  collectDefaultLibrary(options);
}

function collectDefaultLibrary(options: Inventory) {
  const target = options.compiler.getDefaultLibFilePath(
    options.program.getCompilerOptions(),
  );
  if (
    options.frontier.attempts.every(
      (attempt) => attempt.file.lexicalPath !== target,
    )
  )
    return;
  options.requests.record({
    position: -1,
    channel: 'library',
    name: path.basename(target),
    target,
    configField: 'defaultLib',
  });
}

function assertSourceFrontier(
  frontier: NativeProgramFrontier,
  fileName: string,
) {
  if (frontier.inspect(fileName).decision.action !== 'expand')
    throw new Error(`Compiler source bypassed physical frontier: ${fileName}`);
}
