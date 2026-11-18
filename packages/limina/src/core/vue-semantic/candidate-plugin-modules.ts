import type { VueProjectSemanticIdentity } from '#checkers';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { EpochInputReplay } from '../analysis-cache/epoch-inputs';
import { vueExecutionInputs } from '../analysis-cache/vue-execution-inputs';
import { DeclarationObservationUnavailable } from '../declaration-governance/candidate';

interface PluginResolution {
  specifier: string;
  parentURL: string;
  paths?: string[] | undefined;
  require: boolean;
  conditions: string[] | null;
  importAttributes: Record<string, string>;
  resolved: string;
}

const requestSchema: z.ZodType<PluginResolution> = z.object({
  specifier: z.string(),
  parentURL: z.string(),
  paths: z.array(z.string()).optional(),
  require: z.boolean(),
  conditions: z.array(z.string()).nullable(),
  importAttributes: z.record(z.string(), z.string()),
  resolved: z.string(),
});
export const pluginResolutionsSchema: z.ZodType<PluginResolution[]> =
  z.array(requestSchema);

/** The resolver hooks run inside the isolated compiler. Follow only requests
 * reachable from a plugin declared by this candidate's own config closure. */
export const observePluginResolutions = `
const moduleAPI = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');
const resolutionEdges = new Map();
const pluginRoots = new Set();
const pluginContents = new Map();
if (input.pluginRequests.length) {
  const entries = new Set(input.pluginRequests.map(([dir, name]) => JSON.stringify([normalize(dir), name])));
  function record(edge) {
    const key = JSON.stringify(edge);
    resolutionEdges.set(key, edge);
    if (edge.paths?.some(dir => entries.has(JSON.stringify([normalize(dir), edge.specifier])))) pluginRoots.add(key);
  }
  let current;
  // The public hook exposes conditions and parentURL, but not the caller's
  // explicit require.resolve search directories used by Vue to locate plugins.
  const original = moduleAPI._resolveFilename;
  moduleAPI._resolveFilename = function(specifier, parent, isMain, options) {
    if (current && specifier === current.specifier) {
      if (options?.paths) current.paths = [...options.paths];
      return original.apply(this, arguments);
    }
    // Node 22 calls _resolveFilename directly for require.resolve(), including
    // Vue's initial request. Other CommonJS and ESM loads invoke the hook.
    if (!parent?.filename || moduleAPI.isBuiltin(specifier)) return original.apply(this, arguments);
    const edge = { specifier, parentURL: pathToFileURL(parent.filename).href, require: true,
      paths: options?.paths, conditions: options?.conditions ? [...options.conditions] : null, importAttributes: {} };
    try {
      const resolved = original.apply(this, arguments);
      edge.resolved = pathToFileURL(resolved).href;
      return resolved;
    } catch (error) {
      edge.resolved = 'error:' + error.code;
      throw error;
    } finally { record(edge); }
  };
  moduleAPI.registerHooks({
    resolve(specifier, context, next) {
      if (!context.parentURL?.startsWith('file:') || moduleAPI.isBuiltin(specifier)) return next(specifier, context);
      const previous = current;
      const conditions = [...context.conditions];
      // Native ESM can consult the CommonJS resolver when a file is missing.
      // Its loader condition still identifies the request as an import.
      const mode = conditions.find(condition => condition === 'require' || condition === 'import');
      const edge = { specifier, parentURL: context.parentURL, require: mode === 'require',
        conditions, importAttributes: { ...context.importAttributes } };
      current = edge;
      try {
        const result = next(specifier, context);
        edge.resolved = result.url;
        return result;
      } catch (error) {
        edge.resolved = 'error:' + error.code;
        throw error;
      } finally {
        current = previous;
        record(edge);
      }
    },
    load(url, context, next) {
      const result = next(url, context);
      if (url.startsWith('file:') && result.source != null)
        pluginContents.set(url, crypto.createHash('sha256').update(result.source).digest('hex'));
      return result;
    },
  });
}
function pluginResolutions() {
  if (input.expectPlugin && !pluginRoots.size) throw new Error('Cannot observe Vue plugin module resolution.');
  const children = new Map();
  for (const [key, edge] of resolutionEdges) {
    if (!children.has(edge.parentURL)) children.set(edge.parentURL, []);
    children.get(edge.parentURL).push(key);
  }
  const reachable = new Set(pluginRoots);
  for (const key of reachable) {
    const { resolved } = resolutionEdges.get(key);
    const digest = pluginContents.get(resolved);
    if (digest !== undefined) reads.set(normalize(fileURLToPath(resolved)), digest);
    for (const child of children.get(resolved) ?? []) reachable.add(child);
  }
  return [...reachable].map(key => resolutionEdges.get(key));
}
`;

// Node caches package manifests, realpaths and successful resolutions within a
// process. Replay these observed requests in a fresh resolver without loading
// any plugin code. Preserve both ESM import and CommonJS lookup semantics.
const replayPluginResolutions = `
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const requests = JSON.parse(readFileSync(0, 'utf8'));
let active;
let resolutionError;
registerHooks({ resolve(specifier, context, next) {
  try {
    return next(specifier, { ...context, conditions: active.conditions ?? context.conditions, importAttributes: active.importAttributes });
  } catch (error) {
    // import.meta.resolve converts a missing relative file into its URL.
    // Retain the actual resolver outcome that import() would observe.
    resolutionError = 'error:' + error.code;
    throw error;
  }
}});
const results = requests.map(request => {
  active = request;
  resolutionError = undefined;
  try {
    if (!request.require) {
      const url = import.meta.resolve(request.specifier, request.parentURL);
      return resolutionError ?? url;
    }
    const resolved = createRequire(request.parentURL).resolve(request.specifier, { paths: request.paths });
    return pathToFileURL(resolved).href;
  } catch (error) { return 'error:' + error.code; }
});
process.stdout.write(JSON.stringify(results));
`;

export function retainVuePluginResolutions(
  identity: VueProjectSemanticIdentity,
  sourceConfig: string,
  requests: PluginResolution[],
): void {
  if (requests.length === 0) return;
  const read = () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-import-meta-resolve',
        '--input-type=module',
        '-e',
        replayPluginResolutions,
      ],
      {
        cwd: path.dirname(sourceConfig),
        input: JSON.stringify(requests),
        encoding: 'utf8',
      },
    );
    if (result.error || result.status !== 0)
      throw new DeclarationObservationUnavailable(
        'Cannot replay Vue plugin module resolution.',
      );
    return JSON.parse(result.stdout) as string[];
  };
  vueExecutionInputs(identity).bind(
    {
      key: JSON.stringify(['vue-plugin-resolutions', identity.configPath]),
      path: sourceConfig,
      read,
      value: requests.map((request) => request.resolved),
    },
    new EpochInputReplay(),
  );
}
