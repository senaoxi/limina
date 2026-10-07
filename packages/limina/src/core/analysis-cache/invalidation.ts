import type {
  AnalysisSnapshot,
  ImporterRecord,
  InputDependency,
} from './contracts';
import type { AnalysisInputs } from './inputs';

function subscribe(
  index: Map<string, Set<string>>,
  input: string,
  consumer: string,
): void {
  const consumers = index.get(input) ?? new Set<string>();
  consumers.add(consumer);
  index.set(input, consumers);
}

/**
Rebuilt from forward records; no second persistent source of truth.
*/
export class AnalysisInvalidation {
  readonly inputQueries: Map<string, Set<string>> = new Map<
    string,
    Set<string>
  >();
  readonly queryImporters: Map<string, Set<string>> = new Map<
    string,
    Set<string>
  >();
  readonly semanticConsumers: Map<string, Set<string>> = new Map<
    string,
    Set<string>
  >();
  readonly resolutionDirty: Set<string> = new Set<string>();
  readonly semanticDirty: Set<string> = new Set<string>();
  readonly syntaxDirty: Set<string> = new Set<string>();

  constructor(snapshot: AnalysisSnapshot | undefined, inputs: AnalysisInputs) {
    if (snapshot === undefined) return;
    this.#index(snapshot);
    this.#invalidate(snapshot, inputs);
  }

  #index(snapshot: AnalysisSnapshot): void {
    for (const [id, query] of Object.entries(snapshot.queries))
      this.#subscribeInputs(this.inputQueries, query.dependencies, id);
    this.#indexEnvironments(snapshot);
    for (const [id, importer] of Object.entries(snapshot.importers)) {
      this.#indexImporter(id, importer);
    }
  }

  #indexEnvironments(snapshot: AnalysisSnapshot): void {
    for (const [contextId, context] of Object.entries(snapshot.contexts))
      this.#indexEnvironment(snapshot, contextId, context.sharedEnvironment);
  }
  #indexEnvironment(
    snapshot: AnalysisSnapshot,
    contextId: string,
    environment: AnalysisSnapshot['contexts'][string]['sharedEnvironment'],
  ): void {
    const consumers = Object.entries(snapshot.importers).filter(
      ([, importer]) => importer.contextId === contextId,
    );
    for (const [id] of consumers) this.#subscribeEnvironment(id, environment);
  }
  #subscribeEnvironment(
    id: string,
    environment: AnalysisSnapshot['contexts'][string]['sharedEnvironment'],
  ): void {
    this.#subscribeInputs(this.semanticConsumers, environment.dependencies, id);
    for (const queryId of environment.queryIds)
      subscribe(this.queryImporters, queryId, id);
  }
  #indexImporter(id: string, importer: ImporterRecord): void {
    this.#subscribeInputs(this.semanticConsumers, importer.dependencies, id);
    for (const query of importer.queryIds)
      subscribe(this.queryImporters, query, id);
  }

  #subscribeInputs(
    index: Map<string, Set<string>>,
    dependencies: InputDependency[],
    consumer: string,
  ): void {
    for (const dependency of dependencies)
      subscribe(index, dependency.inputId, consumer);
  }

  #invalidate(snapshot: AnalysisSnapshot, inputs: AnalysisInputs): void {
    for (const [id, input] of Object.entries(snapshot.inputs)) {
      if (inputs.valid({ inputId: id, expectedVersion: input.version }))
        continue;
      this.#invalidateInput(id);
    }
    this.#invalidateSyntax(snapshot, inputs);
  }

  #invalidateSyntax(snapshot: AnalysisSnapshot, inputs: AnalysisInputs): void {
    for (const [id, importer] of Object.entries(snapshot.importers)) {
      if (
        inputs.observe(importer.filePath, 'content').expectedVersion !==
        importer.sourceVersion
      )
        this.syntaxDirty.add(id);
    }
  }

  #invalidateInput(input: string): void {
    for (const query of subscribers(this.inputQueries, input))
      this.#invalidateQuery(query);
    for (const importer of subscribers(this.semanticConsumers, input))
      this.semanticDirty.add(importer);
  }

  #invalidateQuery(query: string): void {
    this.resolutionDirty.add(query);
    for (const importer of subscribers(this.queryImporters, query))
      this.semanticDirty.add(importer);
  }
}

function subscribers(
  index: Map<string, Set<string>>,
  key: string,
): Iterable<string> {
  return index.get(key) ?? [];
}
