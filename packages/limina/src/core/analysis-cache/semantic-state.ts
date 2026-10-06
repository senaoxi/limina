import { compareCodeUnits } from '#utils/collections';
import type ts from 'typescript';
import type { ImportRecord } from '../import-analysis/records';
import type { TypeScriptSemanticProject } from '../typescript-semantic/contracts';
import type {
  InputDependency,
  ProjectRecord,
  ResolutionRecord,
} from './contracts';
import { analysisHash } from './identity';
import type { AnalysisInputs } from './inputs';
import { projectReferenceInputs } from './reference-inputs';

function isEnvironmentContributor(
  file: ts.SourceFile,
  tsModule: typeof ts,
): boolean {
  return (
    !tsModule.isExternalModule(file) ||
    file.statements.some((statement) => isAugmentation(statement, tsModule))
  );
}

function isAugmentation(node: ts.Node, tsModule: typeof ts): boolean {
  return (
    tsModule.isNamespaceExportDeclaration(node) ||
    isAugmentationModule(node, tsModule)
  );
}

function isAugmentationModule(node: ts.Node, tsModule: typeof ts): boolean {
  return (
    tsModule.isModuleDeclaration(node) && isModuleAugmentation(node, tsModule)
  );
}

interface SemanticStateOptions {
  project: TypeScriptSemanticProject;
  program: ts.Program;
  tsModule: typeof ts;
  inputs: AnalysisInputs;
  queries: Record<string, ResolutionRecord>;
  queriesByFile: Map<string, Set<string>>;
}

export class SemanticState {
  readonly #referenceInputs: Map<string, string[]>;
  readonly environmentDependencies: InputDependency[];
  readonly projectRecord: ProjectRecord;
  readonly environmentVersion: string;
  readonly edges: Map<string, Set<string>> = new Map<string, Set<string>>();
  readonly queriesByFile: Map<string, Set<string>>;
  readonly implicitQueryIds: string[];

  readonly options: SemanticStateOptions;
  constructor(options: SemanticStateOptions) {
    this.options = options;
    this.#referenceInputs = projectReferenceInputs(
      options.program,
      options.tsModule,
    );
    const files = options.program.getSourceFiles();
    this.queriesByFile = options.queriesByFile;
    this.projectRecord = {
      roots: [...options.program.getRootFileNames()],
      members: files.map((file) => file.fileName),
      environment: files
        .filter((file) => isEnvironmentContributor(file, options.tsModule))
        .map((file) => file.fileName),
      references: options.project.projectReferences ?? [],
    };
    this.environmentDependencies = [
      ...new Set(
        this.projectRecord.environment.flatMap((file) => this.#closure(file)),
      ),
    ].map((file) => options.inputs.observe(file, 'content'));
    this.environmentVersion = analysisHash(this.environmentDependencies);
    this.implicitQueryIds = [...this.queriesByFile]
      .filter(([file]) => !this.projectRecord.members.includes(file))
      .flatMap(([, ids]) => [...ids]);
    for (const [file, ids] of this.queriesByFile) this.#addEdges(file, ids);
  }

  #addEdges(file: string, ids: Set<string>): void {
    const targets = new Set<string>(this.#referenceInputs.get(file));
    for (const id of ids) this.#addTarget(targets, this.options.queries[id]);
    this.#addProvider(file, targets);
    this.edges.set(file, targets);
  }

  #addProvider(file: string, targets: Set<string>): void {
    const source = this.options.program.getSourceFile(file);
    if (source !== undefined) targets.add(source.fileName);
  }

  #addTarget(targets: Set<string>, query: ResolutionRecord): void {
    const raw = query.result as {
      resolvedModule?: { resolvedFileName: string };
      resolvedTypeReferenceDirective?: { resolvedFileName: string };
    };
    const target = raw.resolvedModule ?? raw.resolvedTypeReferenceDirective;
    if (target !== undefined) targets.add(target.resolvedFileName);
  }

  #queries(file: string): string[] {
    return [...(this.queriesByFile.get(file) ?? [])];
  }

  #membership(file: string) {
    const source = this.options.program.getSourceFile(file);
    const isReferencedInput = this.#references().some((reference) =>
      reference?.commandLine.fileNames.includes(file),
    );
    return [
      file,
      this.projectRecord.roots.includes(file),
      this.projectRecord.members.includes(file),
      isReferencedInput,
      this.options.project.workspaceSourceBoundary.has(file),
      source?.impliedNodeFormat,
      source !== undefined &&
        this.options.program.isSourceFileFromExternalLibrary(source),
    ];
  }

  #references() {
    return this.options.program.getResolvedProjectReferences() ?? [];
  }

  #closure(file: string): string[] {
    const seen = new Set<string>();
    const queue = [file];
    while (queue.length > 0) this.#visit(queue.pop()!, seen, queue);
    return [...seen].sort(compareCodeUnits);
  }

  #visit(file: string, seen: Set<string>, queue: string[]): void {
    if (seen.has(file)) return;
    seen.add(file);
    this.#addEdges(file, new Set(this.#queries(file)));
    queue.push(...(this.edges.get(file) ?? []));
  }

  dependencies(filePath: string): {
    dependencies: InputDependency[];
    queryIds: string[];
    membershipVersion: string;
    complete: boolean;
  } {
    const paths = this.#closure(filePath);
    const queryIds = [
      ...new Set([
        ...this.implicitQueryIds,
        ...this.projectRecord.environment
          .flatMap((file) => this.#closure(file))
          .flatMap((file) => this.#queries(file)),
        ...paths.flatMap((file) => this.#queries(file)),
      ]),
    ];
    const queries = queryIds.map((id) => this.options.queries[id]);
    const dependencies = paths.map((file) =>
      this.options.inputs.observe(file, 'content'),
    );
    dependencies.push(
      ...this.environmentDependencies,
      ...queries.flatMap((query) => query.dependencies),
    );
    return {
      dependencies: new Map(
        dependencies.map((dependency) => [dependency.inputId, dependency]),
      )
        .values()
        .toArray(),
      queryIds,
      membershipVersion: analysisHash(
        paths.map((file) => this.#membership(file)),
      ),
      complete: queries.every((query) => query.coverage === 'complete'),
    };
  }
}

export function occurrenceKey(record: ImportRecord): string {
  return JSON.stringify([
    record.domain,
    record.kind,
    record.specifier,
    record.locator,
    record.configurationSource,
  ]);
}

function isModuleAugmentation(
  node: ts.ModuleDeclaration,
  tsModule: typeof ts,
): boolean {
  return (
    Boolean(node.flags & tsModule.NodeFlags.GlobalAugmentation) ||
    tsModule.isStringLiteral(node.name)
  );
}
