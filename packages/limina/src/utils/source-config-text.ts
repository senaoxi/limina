import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import {
  type AnalysisRead,
  observeAnalysisRead,
  readTypeScriptConfigInput,
  withAdditionalAnalysisReads,
} from './analysis-input';
import { normalizeAbsolutePath } from './path';

interface SourceConfigTextScope {
  disk: Map<string, { input: AnalysisRead; text: string | undefined }>;
  overlays: WeakMap<
    ReadonlyMap<string, string>,
    { id: string; observed: Map<string, string | undefined> }
  >;
  raw: Map<
    string,
    { text: string | undefined; result: ReturnType<typeof ts.readConfigFile> }
  >;
}

const scopes = new AsyncLocalStorage<SourceConfigTextScope>();

export function withSourceConfigTextScope<T>(operation: () => T): T {
  return scopes.getStore() === undefined
    ? scopes.run(
        { disk: new Map(), overlays: new WeakMap(), raw: new Map() },
        operation,
      )
    : operation();
}

function readOverlayText(
  file: string,
  virtualFiles: ReadonlyMap<string, string>,
  scope: SourceConfigTextScope,
): string | undefined {
  let view = scope.overlays.get(virtualFiles);
  if (view === undefined) {
    view = { id: randomUUID(), observed: new Map() };
    scope.overlays.set(virtualFiles, view);
  }
  const read = () => virtualFiles.get(file);
  const value = read();
  observeAnalysisRead({
    key: JSON.stringify(['config-overlay', view.id, file]),
    path: file,
    value,
    read,
    virtual: true,
  });
  if (view.observed.has(file) && view.observed.get(file) !== value)
    throw new Error(`Source config overlay changed during analysis: ${file}`);
  view.observed.set(file, value);
  return value;
}

export function readSourceConfigText(
  fileName: string,
  virtualFiles?: ReadonlyMap<string, string>,
  readFile: typeof ts.sys.readFile = ts.sys.readFile,
): string | undefined {
  const file = normalizeAbsolutePath(fileName);
  const scope = scopes.getStore();
  const overlay =
    virtualFiles === undefined || scope === undefined
      ? virtualFiles?.get(file)
      : readOverlayText(file, virtualFiles, scope);
  if (overlay !== undefined) return overlay;
  const read = () => readTypeScriptConfigInput(file, () => readFile(file));
  if (scope === undefined) return read();
  const existing = scope.disk.get(file);
  if (existing !== undefined) {
    observeAnalysisRead(existing.input);
    return existing.text;
  }
  let captured: AnalysisRead | undefined;
  const text = withAdditionalAnalysisReads((input) => {
    if (input.descriptor?.kind === 'config-text' && input.path === file)
      captured = input;
  }, read);
  if (captured !== undefined) scope.disk.set(file, { input: captured, text });
  return text;
}

export function readRawSourceConfig(
  configPath: string,
  virtualFiles?: ReadonlyMap<string, string>,
): ReturnType<typeof ts.readConfigFile> {
  // Snapshot acquisition can reject drift. Do it outside TypeScript's read
  // callback so that the invocation can distinguish drift from JSONC errors.
  const text = readSourceConfigText(configPath, virtualFiles);
  const raw = scopes.getStore()?.raw;
  const parse = () => ts.readConfigFile(configPath, () => text);
  if (raw === undefined) return parse();
  let cached = raw.get(configPath);
  if (cached === undefined || cached.text !== text) {
    cached = { text, result: parse() };
    raw.set(configPath, cached);
  }
  const { result } = cached;
  return result.error === undefined
    ? { config: structuredClone(result.config) }
    : result;
}
