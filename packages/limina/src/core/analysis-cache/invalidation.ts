import type { AnalysisSnapshot, InputDependency } from './contracts';
import type { AnalysisInputs } from './inputs';

/**
Rebuilt from forward records; no second persistent source of truth.
*/
export class AnalysisInvalidation {
  readonly #snapshot: AnalysisSnapshot | undefined;
  readonly resolutionDirty: Set<string> = new Set<string>();
  readonly semanticDirty: Set<string> = new Set<string>();
  readonly contextDirty: Set<string> = new Set<string>();
  readonly syntaxDirty: Set<string> = new Set<string>();

  constructor(snapshot: AnalysisSnapshot | undefined, inputs: AnalysisInputs) {
    this.#snapshot = snapshot;
    if (snapshot === undefined) return;
    const changed = new Set<string>();
    for (const [id, input] of Object.entries(snapshot.inputs))
      if (!inputs.valid({ inputId: id, expectedVersion: input.version }))
        changed.add(id);
    if (changed.size > 0) this.#invalidate(snapshot, changed);
    this.#invalidateSyntax(snapshot, inputs);
    for (const [id, { project }] of Object.entries(snapshot.contexts)) {
      const authority =
        snapshot.authorities[project.configPath] ??
        snapshot.authorities[project.sourceConfigPath ?? ''];
      if (authority !== undefined && !inputs.configCurrent(authority.closure))
        this.invalidateContext(id);
    }
  }

  #invalidate(snapshot: AnalysisSnapshot, changed: Set<string>): void {
    const isInputChanged = (input: InputDependency): boolean =>
      changed.has(input.inputId);
    const isQueryDirty = (id: string): boolean => this.resolutionDirty.has(id);
    const resolutionContexts = new Set<string>();
    const semanticContexts = new Set<string>();
    for (const [id, context] of Object.entries(snapshot.contexts)) {
      if (context.environment.dependencies.some(isInputChanged)) {
        resolutionContexts.add(id);
        semanticContexts.add(id);
      } else if (context.sharedEnvironment.dependencies.some(isInputChanged)) {
        semanticContexts.add(id);
      }
    }

    for (const [id, query] of Object.entries(snapshot.queries))
      if (query.dependencies.some(isInputChanged)) this.resolutionDirty.add(id);
    if (resolutionContexts.size > 0)
      for (const importer of Object.values(snapshot.importers))
        if (resolutionContexts.has(importer.contextId))
          for (const id of importer.queryIds) this.resolutionDirty.add(id);

    // A query dirtied in one context can also serve another context.
    for (const [id, context] of Object.entries(snapshot.contexts))
      if (context.sharedEnvironment.queryIds.some(isQueryDirty))
        semanticContexts.add(id);
    for (const [id, importer] of Object.entries(snapshot.importers))
      if (
        semanticContexts.has(importer.contextId) ||
        importer.dependencies.some(isInputChanged) ||
        importer.queryIds.some(isQueryDirty)
      )
        this.semanticDirty.add(id);
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

  invalidateContext(id: string): void {
    this.contextDirty.add(id);
    const snapshot = this.#snapshot;
    if (snapshot === undefined) return;
    for (const [key, query] of Object.entries(snapshot.queries))
      if (query.contextId === id) this.resolutionDirty.add(key);
    for (const [key, importer] of Object.entries(snapshot.importers))
      if (importer.contextId === id) this.semanticDirty.add(key);
  }
}
