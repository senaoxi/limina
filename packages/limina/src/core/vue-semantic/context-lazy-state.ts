import type {
  VueLanguageServiceHost,
  VueProjectSemanticIdentity,
} from '#checkers';
import type ts from 'typescript';

export interface ProgramCreationMeasurement {
  durationMs: number;
  program: ts.Program;
}

export type ProgramCreationObserver = (
  measurement: ProgramCreationMeasurement,
) => void;

function requireLanguageServiceProgram(
  languageService: ts.LanguageService,
): ts.Program {
  const program = languageService.getProgram();
  if (program !== undefined) return program;
  throw new Error('Vue Language Service did not create a Program.');
}

export function createMeasuredProgram(options: {
  languageService: ts.LanguageService;
  observer: ProgramCreationObserver | undefined;
}): ts.Program {
  const startedAt = performance.now();
  const program = requireLanguageServiceProgram(options.languageService);
  options.observer?.({
    durationMs: Math.max(0, performance.now() - startedAt),
    program,
  });
  return program;
}

function getLanguageVersion(options: {
  identity: VueProjectSemanticIdentity;
  tsModule: typeof ts;
}): ts.ScriptTarget {
  return (
    options.identity.options.target ?? options.tsModule.ScriptTarget.Latest
  );
}

function getScriptKind(
  host: VueLanguageServiceHost,
  fileName: string,
): ts.ScriptKind | undefined {
  return host.getScriptKind?.(fileName);
}

function createSemanticSourceFile(options: {
  fileName: string;
  host: VueLanguageServiceHost;
  identity: VueProjectSemanticIdentity;
  tsModule: typeof ts;
}): ts.SourceFile | undefined {
  const snapshot = options.host.getScriptSnapshot(options.fileName);
  if (snapshot === undefined) return undefined;
  return options.tsModule.createSourceFile(
    options.fileName,
    snapshot.getText(0, snapshot.getLength()),
    getLanguageVersion(options),
    true,
    getScriptKind(options.host, options.fileName),
  );
}

export function getCachedSemanticSourceFile(options: {
  cache: Map<string, ts.SourceFile>;
  fileName: string;
  host: VueLanguageServiceHost;
  identity: VueProjectSemanticIdentity;
  tsModule: typeof ts;
}): ts.SourceFile | undefined {
  const existing = options.cache.get(options.fileName);
  if (existing !== undefined) return existing;
  const sourceFile = createSemanticSourceFile(options);
  if (sourceFile !== undefined) options.cache.set(options.fileName, sourceFile);
  return sourceFile;
}
