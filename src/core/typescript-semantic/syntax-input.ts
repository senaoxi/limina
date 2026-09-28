import ts from 'typescript';

// Only the native Program may supply the parser callback described below.
// Foreign hosts, framework ASTs and calls outside this synchronous scope bypass.
const nativeCreateProgram = ts.createProgram;
const nativeCreateCompilerHost = ts.createCompilerHost;
const ownedInput: unique symbol = Symbol('owned syntax input');

export interface OwnedSyntaxInput {
  readonly [ownedInput]: true;
  readonly descriptor: string;
  readonly text: string;
  readonly compiler: typeof ts;
}

type ParserInput = ts.ScriptTarget | ts.CreateSourceFileOptions;
type ParserSource = ts.SourceFile & {
  scriptKind?: ts.ScriptKind;
  parseDiagnostics?: readonly ts.Diagnostic[];
};

const knownParserKeys = new Set([
  'languageVersion',
  'impliedNodeFormat',
  'setExternalModuleIndicator',
  'jsDocParsingMode',
  'packageJsonLocations',
  'packageJsonScope',
]);

function knownParserInput(input: ParserInput): boolean {
  if (typeof input === 'number') return Number.isInteger(input);
  return Object.keys(input).every((key) => knownParserKeys.has(key));
}

function cleanParse(sourceFile: ParserSource): boolean {
  if (!Array.isArray(sourceFile.parseDiagnostics)) return false;
  return sourceFile.parseDiagnostics.length === 0;
}

function parserDescriptor(options: {
  compilerOptions: ts.CompilerOptions;
  input: ParserInput;
  sourceFile: ParserSource;
}): string {
  const input: ts.CreateSourceFileOptions =
    typeof options.input === 'number'
      ? { languageVersion: options.input }
      : options.input;
  const sf = options.sourceFile;
  return JSON.stringify([
    'import-records-v1',
    ts.version,
    sf.fileName,
    typeof options.input,
    typeof input.setExternalModuleIndicator,
    input.languageVersion,
    sf.languageVersion,
    sf.scriptKind,
    sf.languageVariant,
    input.impliedNodeFormat,
    input.jsDocParsingMode,
    // Native getSetExternalModuleIndicator closes over these options.
    options.compilerOptions.moduleDetection,
    options.compilerOptions.module,
    options.compilerOptions.jsx,
  ]);
}

export class OwnedSyntaxScope {
  #active = false;
  readonly #compilerOptions: ts.CompilerOptions;
  readonly #compiler: typeof ts;

  constructor(compilerOptions: ts.CompilerOptions, compiler: typeof ts) {
    this.#compilerOptions = compilerOptions;
    this.#compiler = compiler;
  }

  createProgram(options: ts.CreateProgramOptions): ts.Program {
    this.#active = true;
    try {
      return this.#compiler.createProgram(options);
    } finally {
      this.#active = false;
    }
  }

  #nativeParser(): boolean {
    return [
      this.#active,
      this.#compiler === ts,
      this.#compiler.createProgram === nativeCreateProgram,
      this.#compiler.createCompilerHost === nativeCreateCompilerHost,
      // Fail closed on toolchain upgrades until the recipe is audited/tested.
      this.#compiler.version === '6.0.3',
    ].every(Boolean);
  }

  capture(
    sourceFile: ParserSource,
    input: ParserInput,
  ): OwnedSyntaxInput | undefined {
    const safe = [
      this.#nativeParser(),
      knownParserInput(input),
      cleanParse(sourceFile),
      Number.isInteger(sourceFile.scriptKind),
      /\.(?:[cm]?[jt]s|[jt]sx|json)$/u.test(sourceFile.fileName),
    ].every(Boolean);
    if (!safe) return undefined;
    return {
      [ownedInput]: true,
      compiler: this.#compiler,
      descriptor: parserDescriptor({
        compilerOptions: this.#compilerOptions,
        input,
        sourceFile,
      }),
      text: sourceFile.text,
    };
  }
}
