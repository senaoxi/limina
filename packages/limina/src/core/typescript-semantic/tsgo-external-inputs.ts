import { observeAnalysisRead } from '#utils/analysis-input';
import { compareCodeUnits } from '#utils/collections';
import { normalizeAbsolutePath } from '#utils/path';
import type { API, Project } from '@typescript/native-preview/unstable/sync';
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'pathe';
import ts from 'typescript';
import type {
  NativeRequest,
  NativeResolution,
} from '../../domain/analysis/native-evidence';
import { EpochInputs } from '../analysis-cache/epoch-inputs';
import { observeNativeHostInputs } from './native-host-inputs';
import type {
  NativeObservedProgram,
  NativeProgramSource,
} from './native-program-api';
import { observedCompilerSystem } from './observed-resolution-host';

export interface ExternalInputRequest {
  request: NativeRequest;
  resolution: NativeResolution | undefined;
}
export interface ExternalInputObservation {
  state: 'compatible' | 'incompatible' | 'unverified';
  reason: string;
  target?: string;
  external?: boolean;
}

/** A fresh, read-only Program observation, not a replacement resolver. The
 * public API does not expose raw resolution flags. With no project references,
 * its Program has the CLI loading contract; compare actual inputs and bind the
 * request's module symbol before accepting the narrower no-emit proof. */
export async function observeTsgoExternalInputs(input: {
  config: string;
  executionRoot: string;
  cwd: string;
  requests: readonly ExternalInputRequest[];
}): Promise<ExternalInputObservation[]> {
  const reads = new EpochInputs();
  let api: API | undefined;
  try {
    const result = reads.run(() => {
      const system = observedCompilerSystem(ts, input.config);
      const parsed = ts.getParsedCommandLineOfConfigFile(
        input.config,
        {},
        {
          ...system,
          onUnRecoverableConfigFileDiagnostic: () => {
            throw new Error('Cannot parse the observation config.');
          },
        },
      );
      if (parsed === undefined || parsed.errors.length > 0)
        throw new Error('Compiler configuration is unavailable.');
      // The API project system enables UseSourceOfProjectReference. Do not
      // project it onto a CLI build by rewriting options or references.
      if (parsed.projectReferences?.length)
        throw new Error(
          'Native API source-reference redirection is not qualified for this build.',
        );
      const host = ts.createCompilerHost(parsed.options, true);
      host.getCurrentDirectory = () => input.cwd;
      observeNativeHostInputs(host);
      const program = ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        host,
      }) as NativeObservedProgram;
      program.getTypeChecker();
      const require = createRequire(
        path.join(input.executionRoot, 'package.json'),
      );
      const native = require('@typescript/native-preview/unstable/sync') as {
        API: typeof API;
      };
      api = new native.API({
        cwd: input.cwd,
        fs: {
          readFile: (file) => system.readFile(file) ?? null,
          fileExists: system.fileExists,
          directoryExists: system.directoryExists,
          realpath: system.realpath,
          getAccessibleEntries: directoryEntries,
        },
      });
      const snapshot = api.updateSnapshot({ openProjects: [input.config] });
      try {
        const project = snapshot.getProject(input.config);
        if (project === undefined)
          throw new Error('Native configured Program is unavailable.');
        const gap = programGap(program, project);
        return input.requests.map((entry) =>
          observeRequest(program, project, entry, gap),
        );
      } finally {
        snapshot.dispose();
      }
    });
    await reads.assertStable();
    return result;
  } catch (error) {
    return input.requests.map(() => ({
      state: 'unverified',
      reason: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    api?.close();
  }
}

function directoryEntries(directory: string): {
  files: string[];
  directories: string[];
} {
  const read = () => {
    const result = { files: [] as string[], directories: [] as string[] };
    if (!ts.sys.directoryExists(directory)) return result;
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const info = entry.isSymbolicLink()
        ? statSync(path.join(directory, entry.name), { throwIfNoEntry: false })
        : entry;
      if (info?.isFile()) result.files.push(entry.name);
      if (info?.isDirectory()) result.directories.push(entry.name);
    }
    result.files.sort(compareCodeUnits);
    result.directories.sort(compareCodeUnits);
    return result;
  };
  const value = read();
  observeAnalysisRead({
    path: directory,
    key: JSON.stringify(['native-api-entries', directory]),
    value,
    read,
  });
  return value;
}

function hasSameFiles(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    JSON.stringify(
      left.map((file) => normalizeAbsolutePath(file)).sort(compareCodeUnits),
    ) ===
    JSON.stringify(
      right.map((file) => normalizeAbsolutePath(file)).sort(compareCodeUnits),
    )
  );
}
function programGap(program: ts.Program, project: Project): string | undefined {
  if (!hasSameFiles(program.getRootFileNames(), project.rootFiles))
    return 'Native and TypeScript root membership differs.';
  const files = program
    .getSourceFiles()
    .filter((file) => !program.isSourceFileDefaultLibrary(file));
  const nativeFiles = project.program.getSourceFileNames().filter((file) => {
    const metadata = project.program.getSourceFileMetadata(file);
    if (metadata === undefined)
      throw new Error(`Native file metadata unavailable: ${file}`);
    return !metadata.isDefaultLibrary;
  });
  if (
    !hasSameFiles(
      files.map((file) => file.fileName),
      nativeFiles,
    )
  )
    return 'Native and TypeScript non-default-library input membership differs.';
  for (const file of files) {
    const nativeFile = project.program.getSourceFile(file.fileName);
    if (
      nativeFile?.text !== file.text ||
      nativeFile.isDeclarationFile !== file.isDeclarationFile
    )
      return `Native input text or declaration classification differs: ${file.fileName}`;
    const metadata = project.program.getSourceFileMetadata(file.fileName);
    if (metadata === undefined)
      return `Native input metadata unavailable: ${file.fileName}`;
    if (
      metadata.isFromExternalLibrary !==
      program.isSourceFileFromExternalLibrary(file)
    )
      return `Native and TypeScript Program external membership differs: ${file.fileName}`;
  }
  return undefined;
}

function observeRequest(
  program: NativeObservedProgram,
  project: Project,
  entry: ExternalInputRequest,
  gap: string | undefined,
): ExternalInputObservation {
  const { request, resolution } = entry;
  if (request.channel !== 'module' || request.entry.kind !== 'source')
    return {
      state: 'unverified',
      reason:
        'Native module position is unavailable for this Compiler Request.',
    };
  const file = program.getSourceFile(request.sourceFile?.lexicalPath ?? '') as
    | NativeProgramSource
    | undefined;
  const position = request.entry.position;
  const literal = file?.imports.find(
    (node) => node.pos === position && node.text === request.specifier,
  );
  if (file === undefined || literal === undefined)
    return {
      state: 'unverified',
      reason:
        'The original Compiler Request is absent from the observed Program.',
    };
  const mode = program.getModeForUsageLocation(file, literal);
  const resolved = program.getResolvedModule(
    file,
    literal.text,
    mode,
  )?.resolvedModule;
  if (
    resolved === undefined ||
    String(mode ?? '') !== (request.resolutionMode ?? '') ||
    resolved?.resolvedFileName !== resolution?.target?.lexicalPath ||
    resolved?.isExternalLibraryImport !== resolution?.externalLibrary
  )
    return {
      state: 'unverified',
      reason:
        'Live TypeScript resolution does not match the admitted request identity.',
    };
  const source = project.program.getSourceFile(file.fileName);
  if (source?.text !== file.text)
    return {
      state: 'unverified',
      reason: 'Native and TypeScript source text differs or is unavailable.',
    };
  const symbol = project.checker.getSymbolAtPosition(
    file.fileName,
    literal.getStart(file) + 1,
  );
  const declaration =
    symbol?.declarations.length === 1
      ? symbol.declarations[0]!.resolve()
      : undefined;
  // Only a module backed by that exact SourceFile proves the target. Ambient,
  // merged, unresolved and redirected symbols cannot substitute for it.
  if (declaration?.kind !== source.kind)
    return {
      state: 'unverified',
      reason: 'Native module symbol has no unique SourceFile declaration.',
    };
  const target = (declaration as typeof source).fileName;
  const external =
    project.program.getSourceFileMetadata(target)?.isFromExternalLibrary;
  if (target !== resolved.resolvedFileName)
    return {
      state: 'incompatible',
      target,
      external,
      reason: 'Native module symbol selects a different input file.',
    };
  if (external === undefined)
    return {
      state: 'unverified',
      target,
      reason: 'Native target metadata is unavailable.',
    };
  if (!external)
    return {
      state: 'incompatible',
      target,
      external,
      reason:
        'Native does not exclude the implementation from consumer emit as an external input.',
    };
  if (gap !== undefined)
    return { state: 'unverified', target, external, reason: gap };
  return {
    state: 'compatible',
    target,
    external,
    reason:
      'Both actual Programs retain the same inputs and external membership, and this module selects the same external implementation.',
  };
}
