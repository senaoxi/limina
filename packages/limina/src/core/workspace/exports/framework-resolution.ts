import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';
import { AstroSemanticContextManager } from '../../astro-semantic/context';
import { SvelteSemanticContextManager } from '../../svelte-semantic/context';
import {
  createSvelteResolutionHost,
  resolveSvelteModuleOccurrence,
} from '../../svelte-semantic/module-resolution';
import { VueSemanticContextManager } from '../../vue-semantic/context';
import type {
  PackageExportEntry,
  WorkspaceExportsResolutionProfile,
} from './types';

interface ExportRequest {
  entry: PackageExportEntry;
  profile: WorkspaceExportsResolutionProfile;
}

interface LiteralContext {
  resolveModuleNameLiterals(
    literals: readonly ts.StringLiteralLike[],
  ): ReadonlyMap<
    ts.StringLiteralLike,
    ts.ResolvedModuleWithFailedLookupLocations
  >;
}

function createExportLiteral(
  entry: PackageExportEntry,
  tsModule: typeof ts,
  mode: 'import' | 'require',
): ts.StringLiteralLike {
  // Package capability probes are not compiler roots or occurrence evidence.
  // Give each probe an explicit format; package.json has no SourceFile format.
  const sourceFile = tsModule.createSourceFile(
    entry.packageJsonPath,
    mode === 'import'
      ? `import ${JSON.stringify(entry.specifier)};`
      : `import value = require(${JSON.stringify(entry.specifier)});`,
    tsModule.ScriptTarget.Latest,
    true,
    tsModule.ScriptKind.TS,
  );
  sourceFile.impliedNodeFormat =
    mode === 'import'
      ? tsModule.ModuleKind.ESNext
      : tsModule.ModuleKind.CommonJS;
  return getExportLiteral(sourceFile.statements[0]!, tsModule);
}

function getExportLiteral(
  statement: ts.Statement,
  tsModule: typeof ts,
): ts.StringLiteralLike {
  return tsModule.isImportDeclaration(statement)
    ? (statement.moduleSpecifier as ts.StringLiteralLike)
    : ((
        (statement as ts.ImportEqualsDeclaration)
          .moduleReference as ts.ExternalModuleReference
      ).expression as ts.StringLiteralLike);
}

function createExportLiterals(
  entry: PackageExportEntry,
  tsModule: typeof ts,
): ts.StringLiteralLike[] {
  return (['import', 'require'] as const).map((mode) =>
    createExportLiteral(entry, tsModule, mode),
  );
}

function isTypedTarget(fileName: string): boolean {
  return !/\.(?:cjs|mjs|jsx|js)$/u.test(fileName);
}

function resolveHostExport(options: {
  context: LiteralContext;
  entry: PackageExportEntry;
  tsModule: typeof ts;
}): string | null {
  const literals = createExportLiterals(options.entry, options.tsModule);
  const resolved = options.context.resolveModuleNameLiterals(literals);
  const names = literals.flatMap((literal) => {
    const target = resolved.get(literal)?.resolvedModule;
    return target === undefined
      ? []
      : [normalizeAbsolutePath(target.resolvedFileName)];
  });
  return names.find(isTypedTarget) ?? null;
}

export class FrameworkExportResolver {
  readonly #vue = new VueSemanticContextManager();
  readonly #astro = new AstroSemanticContextManager();
  readonly #svelte = new SvelteSemanticContextManager();

  #resolveVue(request: ExportRequest): string | null {
    const identity = request.profile.vueSemanticIdentity;
    if (identity === undefined) return null;
    const context = this.#vue.acquire(identity);
    return resolveHostExport({
      context,
      entry: request.entry,
      tsModule: context.tsModule,
    });
  }

  #resolveAstro(request: ExportRequest): string | null {
    const project = request.profile.astroSemanticProject;
    if (project === undefined) return null;
    const context = this.#astro.acquire(project);
    return resolveHostExport({
      context,
      entry: request.entry,
      tsModule: context.toolchain.tsModule,
    });
  }

  #resolveSvelte(request: ExportRequest): string | null {
    const project = request.profile.svelteSemanticProject;
    if (project === undefined) return null;
    const { tsModule } = this.#svelte.acquire(project).toolchain;
    const literals = createExportLiterals(request.entry, tsModule);
    const names = literals.flatMap((literal) => {
      const result = resolveSvelteModuleOccurrence({
        cache: tsModule.createModuleResolutionCache(
          project.packageRootDir,
          (fileName) => fileName,
          project.options,
        ),
        host: createSvelteResolutionHost(tsModule),
        literal,
        project,
        sourceFile: literal.getSourceFile(),
        tsModule,
      });
      return result.target === null ? [] : [result.target.resolvedFileName];
    });
    return names.find(isTypedTarget) ?? null;
  }

  resolve(request: ExportRequest): string | null {
    const resolvers = [
      () => this.#resolveVue(request),
      () => this.#resolveAstro(request),
      () => this.#resolveSvelte(request),
    ];
    for (const resolve of resolvers) {
      const result = resolve();
      if (result !== null) return result;
    }
    return null;
  }

  dispose(): void {
    this.#vue.dispose();
    this.#astro.dispose();
    this.#svelte.dispose();
  }
}
