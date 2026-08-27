import type { VueLanguageServiceHost, VueResolvedModule } from '#checkers';
import type ts from 'typescript';

type ModuleLiteralResolver = NonNullable<
  VueLanguageServiceHost['resolveModuleNameLiterals']
>;

function requireLiteralResolver(
  host: VueLanguageServiceHost,
): ModuleLiteralResolver {
  const resolver = host.resolveModuleNameLiterals;
  if (resolver !== undefined) return resolver;
  throw new Error(
    'The Vue semantic Language Service host does not expose resolveModuleNameLiterals.',
  );
}

function getLiteralGroup(
  groups: Map<ts.SourceFile, ts.StringLiteralLike[]>,
  sourceFile: ts.SourceFile,
): ts.StringLiteralLike[] {
  const existing = groups.get(sourceFile);
  if (existing !== undefined) return existing;
  const created: ts.StringLiteralLike[] = [];
  groups.set(sourceFile, created);
  return created;
}

function groupLiteralsBySourceFile(
  literals: readonly ts.StringLiteralLike[],
): Map<ts.SourceFile, ts.StringLiteralLike[]> {
  const groups = new Map<ts.SourceFile, ts.StringLiteralLike[]>();
  for (const literal of literals) {
    getLiteralGroup(groups, literal.getSourceFile()).push(literal);
  }
  return groups;
}

function createResolvedLiteralEntry(options: {
  index: number;
  literal: ts.StringLiteralLike;
  results: readonly VueResolvedModule[];
}): readonly (readonly [ts.StringLiteralLike, VueResolvedModule])[] {
  const result = options.results[options.index];
  if (result === undefined) return [];
  return [[options.literal, result]];
}

function getUnavailableReusedNames():
  | readonly ts.StringLiteralLike[]
  | undefined {
  return undefined;
}

function resolveLiteralGroup(options: {
  compilerOptions: ts.CompilerOptions;
  literals: readonly ts.StringLiteralLike[];
  resolver: ModuleLiteralResolver;
  sourceFile: ts.SourceFile;
}): readonly (readonly [ts.StringLiteralLike, VueResolvedModule])[] {
  const results = options.resolver(
    options.literals,
    options.sourceFile.fileName,
    undefined,
    options.compilerOptions,
    options.sourceFile,
    getUnavailableReusedNames(),
  );
  return options.literals.flatMap((literal, index) =>
    createResolvedLiteralEntry({ index, literal, results }),
  );
}

export function resolveModuleNameLiteralMap(options: {
  compilerOptions: ts.CompilerOptions;
  host: VueLanguageServiceHost;
  literals: readonly ts.StringLiteralLike[];
}): ReadonlyMap<ts.StringLiteralLike, VueResolvedModule> {
  const resolver = requireLiteralResolver(options.host);
  const groups = groupLiteralsBySourceFile(options.literals);
  const entries = [...groups].flatMap(([sourceFile, literals]) =>
    resolveLiteralGroup({
      compilerOptions: options.compilerOptions,
      literals,
      resolver,
      sourceFile,
    }),
  );
  return new Map(entries);
}
