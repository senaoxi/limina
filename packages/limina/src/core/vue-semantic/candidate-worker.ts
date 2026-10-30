/** Runs in an isolated Node process. Keep the worker self-contained: vue-tsc
 * patches the compiler module loader and must never patch Limina's runtime. */
export const vueCandidateWorker: string = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const fromVue = createRequire(input.vueTsc);
const normalize = file => path.resolve(file).replaceAll('\\', '/');
const buildInfoFile = input.buildInfoFile && normalize(input.buildInfoFile);
const files = new Map(input.files.map(([file, text]) => [normalize(file), text]));
const directories = new Set();
for (const file of files.keys()) {
  let dir = path.dirname(file);
  while (!directories.has(dir)) {
    directories.add(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
const read = fs.readFileSync;
const reads = new Map();
const checks = new Map();
const exists = fs.existsSync;
const stat = fs.statSync;
const readdir = fs.readdirSync;
const realpath = fs.realpathSync;
const sample = stat(process.cwd());
fs.readFileSync = (file, encoding) => {
  // Always construct a fresh candidate. Incremental state is an output that
  // the subsequent build may replace, not evidence for the Reference Map.
  if (typeof file === 'string' && normalize(file) === buildInfoFile) {
    const error = new Error('Candidate observation does not reuse build info.');
    error.code = 'ENOENT';
    throw error;
  }
  const text = typeof file === 'string' ? files.get(normalize(file)) : undefined;
  if (text !== undefined) return encoding ? text : Buffer.from(text);
  const value = read(file, encoding);
  if (typeof file === 'string') reads.set(normalize(file), crypto.createHash('sha256').update(String(value)).digest('hex'));
  return value;
};
fs.existsSync = file => typeof file === 'string' && (files.has(normalize(file)) || directories.has(normalize(file))) || exists(file);
fs.statSync = (file, options) => {
  const name = typeof file === 'string' ? normalize(file) : '';
  if (!files.has(name) && !directories.has(name)) return stat(file, options);
  return Object.assign(Object.create(sample), {
    size: files.has(name) ? Buffer.byteLength(files.get(name)) : 0,
    isFile: () => files.has(name), isDirectory: () => directories.has(name),
  });
};
fs.readdirSync = (file, options) => {
  const name = normalize(file);
  if (!directories.has(name)) return readdir(file, options);
  const values = exists(name) ? readdir(file, options) : [];
  const names = new Set(values.map(value => typeof value === 'string' ? value : value.name));
  for (const item of [...files.keys(), ...directories]) {
    if (path.dirname(item) !== name || names.has(path.basename(item))) continue;
    const child = path.basename(item);
    names.add(child);
    values.push(options && options.withFileTypes ? {
      name: child, parentPath: name,
      isFile: () => files.has(item), isDirectory: () => directories.has(item),
      isSymbolicLink: () => false,
    } : child);
  }
  return values;
};
fs.realpathSync = (file, options) => exists(file) ? realpath(file, options) : normalize(file);
fs.realpathSync.native = fs.realpathSync;
const failWrite = () => { throw new Error('Candidate observation attempted to write an artifact.'); };
fs.writeFileSync = failWrite;
const open = fs.openSync;
fs.openSync = (file, flags, ...rest) => {
  if (flags !== 'r' && flags !== fs.constants.O_RDONLY) failWrite();
  return open(file, flags, ...rest);
};
fs.mkdirSync = failWrite;
fs.unlinkSync = failWrite;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const optionsData = value => Object.fromEntries(Object.entries(value).filter(([key, value]) => key !== 'configFile' && value !== undefined));
const stop = {};
let observation;
let log = '';
const output = process.stdout.write.bind(process.stdout);
process.stdout.write = text => { log += String(text); return true; };
process.stderr.write = process.stdout.write;
process.exit = code => { throw new Error('vue-tsc exited before observation: ' + code + ': ' + log); };
const proxy = fromVue('@volar/typescript/lib/node/proxyCreateProgram');
const original = proxy.proxyCreateProgram;
if (typeof original !== 'function') throw new Error('Unsupported Volar Program proxy.');
proxy.proxyCreateProgram = (ts, createProgram, plugins) => original(ts, (...args) => {
  const options = args[0];
  if (!options || !options.host || !Array.isArray(options.rootNames)) throw new Error('Unsupported vue-tsc Program creation.');
  const host = options.host;
  const roots = new Set(options.rootNames.map(normalize));
  const declarations = new Set(input.declarations.map(normalize));
  const configs = new Set(input.configs.map(normalize));
  const governed = new Set(input.governed);
  const isDeclaration = file => /\.d\.[cm]?ts$/i.test(file);
  const isRetainedDeclaration = file => {
    if (!isDeclaration(file)) return false;
    try { const identity = stat(file, { bigint: true }); return !governed.has(identity.dev + ':' + identity.ino); }
    catch { return false; }
  };
  const callbacks = new Map();
  const effective = new Map();
  // runTsc exposes private compiler bindings through an eval-backed Proxy.
  // Unlike the library API, probing an absent old-version binding can throw.
  let defaultTypeMode;
  try { defaultTypeMode = ts.getDefaultResolutionModeForFileWorker; }
  catch (error) { if (!(error instanceof ReferenceError)) throw error; }
  const typeMode = (reference, source, options) => ts.getModeForFileReference(reference, source && (typeof defaultTypeMode === 'function' ? defaultTypeMode(source, options) : source.impliedNodeFormat));
  const requestKey = (file, position, channel, name, mode) => JSON.stringify([normalize(file), position, channel, name, mode ?? null]);
  const moduleResolver = host.resolveModuleNameLiterals;
  if (typeof moduleResolver !== 'function') throw new Error('Missing Volar literal resolver.');
  host.resolveModuleNameLiterals = (...args) => {
    const results = moduleResolver.apply(host, args);
    const [literals, file, redirect, settings, source] = args;
    const environment = redirect?.commandLine.options ?? settings;
    effective.set(source, environment);
    literals.forEach((literal, index) => {
      const mode = ts.getModeForUsageLocation(source, literal, environment);
      callbacks.set(requestKey(file, literal.pos, literal.pos < 0 ? 'implicit' : 'module', literal.text, mode), {
        result: results[index], redirects: redirect ? [normalize(redirect.sourceFile.fileName)] : [], environment,
      });
    });
    return results;
  };
  // Volar does not replace TypeScript's type-directive resolver. When no host
  // resolver exists, preserve the compiler's default algorithm and mode-aware
  // cache while observing the real request/redirect supplied by this Program.
  const typeCache = ts.createTypeReferenceDirectiveResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName);
  if (!host.resolveTypeReferenceDirectiveReferences && host.resolveTypeReferenceDirectives)
    throw new Error('Unqualified legacy type-directive resolver.');
  const typeResolver = host.resolveTypeReferenceDirectiveReferences ?? ((references, file, redirect, settings, source) =>
    references.map(reference => ts.resolveTypeReferenceDirective(
      typeof reference === 'string' ? reference : reference.fileName,
      file, settings, host, redirect, typeCache,
      typeMode(reference, source, redirect?.commandLine.options ?? settings),
    )));
  if (typeof typeResolver === 'function') host.resolveTypeReferenceDirectiveReferences = (...args) => {
    const results = typeResolver.apply(host, args);
    const [references, file, redirect, settings, source] = args;
    const environment = redirect?.commandLine.options ?? settings;
    if (source) effective.set(source, environment);
    references.forEach((reference, index) => {
      const name = typeof reference === 'string' ? reference : reference.fileName;
      const position = typeof reference === 'string' ? -1 : reference.pos;
      const mode = typeMode(reference, source, environment);
      callbacks.set(requestKey(file, position, 'type-directive', name, mode), {
        result: results[index], redirects: redirect ? [normalize(redirect.sourceFile.fileName)] : [], environment,
      });
    });
    return results;
  };
  const getSource = host.getSourceFile;
  host.getSourceFile = (file, ...rest) => {
    // JSON configuration reads construct the real Reference Map. They are
    // metadata, not source-loading grants. Libraries remain a separate purpose.
    const name = normalize(file);
    const mappingOnly = input.declarations.length === 0 && input.referenceInputs?.length;
    if (configs.has(name) || (!mappingOnly && (roots.has(name) || declarations.has(name) || isRetainedDeclaration(name))))
      return getSource.call(host, file, ...rest);
    return undefined;
  };
  host.writeFile = failWrite;
  const program = createProgram(...args);
  const sources = program.getSourceFiles();
  const requests = [];
  const readReference = file => {
    if (typeof program.getRedirectFromSourceFile === 'function') return program.getRedirectFromSourceFile(file);
    if (typeof program.getResolvedProjectReferenceToRedirect !== 'function' || typeof program.getProjectReferenceRedirect !== 'function')
      throw new Error('Unsupported compiler Reference Map.');
    const reference = program.getResolvedProjectReferenceToRedirect(file);
    return reference ? { resolvedRef: reference, outputDts: program.getProjectReferenceRedirect(file) } : undefined;
  };
  const selectPath = (source, reference) => {
    const settings = program.getCompilerOptions();
    if (settings.noResolve) return {};
    const file = ts.resolveTripleslashReference(reference.fileName, source.fileName);
    const supported = ts.getSupportedExtensions(settings);
    const candidates = settings.allowNonTsExtensions ? [file] : ts.hasExtension(file)
      ? [...supported.flat(), ...(settings.resolveJsonModule ? ['.json'] : [])].some(extension => file.endsWith(extension)) ? [file] : []
      : supported[0].map(extension => file + extension);
    for (const candidate of candidates) {
      const reference = readReference(candidate);
      if (host.fileExists(reference?.outputDts ?? candidate)) return { raw: true, target: { resolvedFileName: candidate } };
    }
    if (candidates.length === 1 && readReference(candidates[0])?.outputDts) return { raw: true, target: { resolvedFileName: candidates[0] } };
    return { raw: true };
  };
  for (const source of sources) {
    if (!isDeclaration(source.fileName)) continue;
    // Older compilers expose no per-file options accessor and intentionally
    // never call the type resolver under noResolve. For a declaration without
    // module requests, the actual Reference Map supplies its context while the
    // Program's noResolve is the independent suppression authority. Do not use
    // this path to fill a missing module-resolution observation.
    const suppressedContext = program.getCompilerOptions().noResolve &&
      !(source.imports?.length) && !source.moduleAugmentations?.some(ts.isStringLiteral)
      ? readReference(source.fileName)?.resolvedRef.commandLine.options ?? program.getCompilerOptions()
      : undefined;
    const settings = program.getCompilerOptionsForFile?.(source) ?? effective.get(source) ?? suppressedContext;
    if (!settings && ((source.imports?.length ?? 0) || source.moduleAugmentations?.some(ts.isStringLiteral) || source.typeReferenceDirectives.length)) throw new Error('Unavailable effective declaration options: ' + source.fileName);
    const add = (position, channel, specifier, mode, raw, target, receipt, ambient = false) => requests.push({
      file: normalize(source.fileName), position, channel, specifier,
      mode: mode === undefined ? null : String(mode), target: target?.resolvedFileName ? normalize(target.resolvedFileName) : null,
      resolutionState: target ? 'resolved' : ambient ? 'ambient' : raw === undefined && ((['type-directive', 'path-directive'].includes(channel) && program.getCompilerOptions().noResolve) || (channel === 'library' && program.getCompilerOptions().noLib)) ? 'suppressed' : raw === undefined ? 'unavailable' : 'unresolved',
      redirects: receipt?.redirects ?? [],
      environment: optionsData(receipt?.environment ?? settings),
      externalLibrary: target?.isExternalLibraryImport ?? null,
    });
    for (const literal of [...(source.imports ?? []), ...(source.moduleAugmentations ?? []).filter(ts.isStringLiteral)]) {
      const mode = ts.getModeForUsageLocation(source, literal, settings);
      const channel = literal.pos < 0 ? 'implicit' : 'module';
      const receipt = callbacks.get(requestKey(source.fileName, literal.pos, channel, literal.text, mode));
      const raw = receipt?.result ?? program.getResolvedModule?.(source, literal.text, mode);
      add(literal.pos, channel, literal.text, mode, raw, raw?.resolvedModule, receipt, source.ambientModuleNames?.includes(literal.text));
    }
    for (const reference of source.typeReferenceDirectives) {
      const mode = typeMode(reference, source, settings);
      const receipt = callbacks.get(requestKey(source.fileName, reference.pos, 'type-directive', reference.fileName, mode));
      const raw = receipt?.result ?? program.getResolvedTypeReferenceDirective?.(source, reference.fileName, mode);
      add(reference.pos, 'type-directive', reference.fileName, mode, raw, raw?.resolvedTypeReferenceDirective, receipt);
    }
    for (const reference of source.referencedFiles) {
      const resolved = selectPath(source, reference);
      add(reference.pos, 'path-directive', reference.fileName, undefined, resolved.raw, resolved.target, { environment: program.getCompilerOptions() });
    }
    for (const reference of source.libReferenceDirectives) {
      const name = ts.libMap?.get(reference.fileName.toLowerCase());
      const library = name && program.resolvedLibReferences?.get(name);
      add(reference.pos, 'library', reference.fileName, undefined, library, library && { resolvedFileName: library.actual }, { environment: program.getCompilerOptions() });
    }
  }
  observation = {
    reads: [...reads],
    checks: [...checks.values()],
    compilerVersion: ts.version,
    sources: sources.map(source => ({ file: normalize(source.fileName), defaultLibrary: !!source.hasNoDefaultLib })),
    mappings: [...new Set([...input.declarations, ...(input.referenceInputs ?? []), ...requests.flatMap(request => request.target ? [request.target] : [])])].map(file => {
      const reference = readReference(file);
      return { file, referenceConfig: reference ? normalize(reference.resolvedRef.sourceFile.fileName) : null,
        declarationOutput: reference?.outputDts ? normalize(reference.outputDts) : null,
        qualified: !isDeclaration(file) || !/^5\.9\.[012](?:$|-)/.test(ts.version) };
    }),
    requests,
    contextId: hash([input.generatedConfig, optionsData(program.getCompilerOptions()), input.files, input.declarations]),
  };
  throw stop;
}, (...args) => {
  const host = args[1].host;
  for (const [method, kind] of [['fileExists', 'file'], ['directoryExists', 'directory'], ['realpath', 'realpath'], ['getDirectories', 'directories']]) {
    const original = host[method];
    if (typeof original !== 'function') continue;
    host[method] = file => {
      const value = original.call(host, file);
      const entry = { kind, file: normalize(file), value };
      const key = kind + ':' + entry.file;
      const previous = checks.get(key);
      if (previous && JSON.stringify(previous.value) !== JSON.stringify(value)) throw new Error('Candidate input changed: ' + entry.file);
      checks.set(key, entry);
      return value;
    };
  }
  return plugins(...args);
});
process.argv = [process.execPath, fromVue.resolve('vue-tsc/bin/vue-tsc.js'), '-p', input.generatedConfig, '--pretty', 'false'];
try { fromVue(process.argv[1]); }
catch (error) { if (error !== stop) { output(JSON.stringify({ error: String(error?.stack ?? error), log })); process.exitCode = 1; } }
if (observation) output(JSON.stringify(observation));
`;
