import { normalizeAbsolutePath } from '#utils/path';
import type ts from 'typescript';

// Evidence from the successful compiler call.
export interface ResolutionOrigin {
  version: 1;
  compiler: string;
  route: 'local' | 'package' | 'type-root' | 'incomplete';
  target: string;
  originalPath?: string;
}

type Resolved = (ts.ResolvedModuleFull | ts.ResolvedTypeReferenceDirective) & {
  resolutionOrigin?: ResolutionOrigin;
  originalPath?: string;
};

class OriginTrace {
  #route: ResolutionOrigin['route'] = 'incomplete';
  readonly #selected = new Map<string, ResolutionOrigin['route']>();
  cached = false;

  #realPath(message: string): void {
    const real = /^Resolving real path for '(.*)', result '(.*)'\.$/.exec(
      message,
    );
    if (!real) return;
    const route = this.#selected.get(normalizeAbsolutePath(real[1]!));
    if (route) this.#selected.set(normalizeAbsolutePath(real[2]!), route);
  }

  #selectRoute(message: string): void {
    this.#route = traceRoute(message, this.#route) ?? this.#route;
  }
  #supportedRoute(version: string, target: string): ResolutionOrigin['route'] {
    return /^(?:5\.[4-9]|6\.0)\./.test(version)
      ? (this.#selected.get(target) ?? 'incomplete')
      : 'incomplete';
  }

  observe(message: string): void {
    if (message.includes('was found in cache from location'))
      this.cached = true;
    this.#selectRoute(message);
    const selected =
      /^File '(.*)' exists - use it as a name resolution result\.$/.exec(
        message,
      );
    if (selected)
      this.#selected.set(normalizeAbsolutePath(selected[1]!), this.#route);
    this.#realPath(message);
  }

  receipt(compiler: typeof ts, result: Resolved): ResolutionOrigin {
    const target = normalizeAbsolutePath(result.resolvedFileName!);
    return {
      version: 1,
      compiler: compiler.version,
      route: this.#supportedRoute(compiler.version, target),
      target,
      ...(result.originalPath !== undefined && {
        originalPath: result.originalPath,
      }),
    };
  }
}

function traceRoute(
  message: string,
  current: ResolutionOrigin['route'],
): ResolutionOrigin['route'] | undefined {
  if (/^(?:Trying substitution|Loading module as file \/ folder)/.test(message))
    return nestedRoute(current);
  const routes: [RegExp, ResolutionOrigin['route']][] = [
    [/^Loading module '.+' from 'node_modules' folder/, 'package'],
    [/^Using 'exports' subpath/, 'package'],
    [/^Using 'imports' subpath/, 'local'],
    [/^Resolving with primary search path/, 'type-root'],
    [
      /^Module name '.+' was successfully resolved to '.+' with Package ID/,
      'package',
    ],
  ];
  return routes.find(([pattern]) => pattern.test(message))?.[1];
}
function requiresReceipt(
  compiler: typeof ts,
  resolved: Resolved | undefined,
): boolean {
  return (
    resolved !== undefined &&
    !isCurrentOrigin(compiler, getResolutionOrigin(resolved))
  );
}
function traceHost(
  host: ts.ModuleResolutionHost,
  options: ts.CompilerOptions,
  trace: OriginTrace,
): ts.ModuleResolutionHost {
  return {
    ...host,
    trace: (message) => {
      trace.observe(message);
      if (options.traceResolution) host.trace?.(message);
    },
  };
}

function attachOrigin(
  compiler: typeof ts,
  trace: OriginTrace,
  resolved: Resolved | undefined,
): void {
  if (!requiresReceipt(compiler, resolved)) return;
  // The compiler caches this result object. The receipt travels with cache hits.
  resolved!.resolutionOrigin = trace.receipt(compiler, resolved!);
}

export function resolveModuleWithOrigin(
  compiler: typeof ts,
  ...arguments_: Parameters<typeof ts.resolveModuleName>
): ReturnType<typeof ts.resolveModuleName> {
  const [name, file, options, host, cache, redirect, mode] = arguments_;
  const trace = new OriginTrace();
  const observedHost = traceHost(host, options, trace);
  const observedOptions = { ...options, traceResolution: true };
  let result = compiler.resolveModuleName(
    name,
    file,
    observedOptions,
    observedHost,
    cache,
    redirect,
    mode,
  );
  const previous = result.resolvedModule;
  if (trace.cached && requiresReceipt(compiler, result.resolvedModule)) {
    result = compiler.resolveModuleName(
      name,
      file,
      observedOptions,
      observedHost,
      undefined,
      redirect,
      mode,
    );
  }
  attachOrigin(compiler, trace, result.resolvedModule);
  pairReceipt(previous, result.resolvedModule);
  return result;
}

export function resolveTypeWithOrigin(
  compiler: typeof ts,
  ...arguments_: Parameters<typeof ts.resolveTypeReferenceDirective>
): ReturnType<typeof ts.resolveTypeReferenceDirective> {
  const [name, file, options, host, redirect, cache, mode] = arguments_;
  const trace = new OriginTrace();
  const observedHost = traceHost(host, options, trace);
  const observedOptions = { ...options, traceResolution: true };
  let result = compiler.resolveTypeReferenceDirective(
    name,
    file,
    observedOptions,
    observedHost,
    redirect,
    cache,
    mode,
  );
  const previous = result.resolvedTypeReferenceDirective;
  if (
    trace.cached &&
    requiresReceipt(compiler, result.resolvedTypeReferenceDirective)
  ) {
    result = compiler.resolveTypeReferenceDirective(
      name,
      file,
      observedOptions,
      observedHost,
      redirect,
      undefined,
      mode,
    );
  }
  attachOrigin(compiler, trace, result.resolvedTypeReferenceDirective);
  pairReceipt(previous, result.resolvedTypeReferenceDirective);
  return result;
}

export function getResolutionOrigin(
  target: Resolved,
): ResolutionOrigin | undefined {
  const receipt = target.resolutionOrigin;
  if (receipt === undefined) return undefined;
  return [
    receipt.version === 1,
    receipt.target === normalizeAbsolutePath(target.resolvedFileName!),
  ].every(Boolean)
    ? receipt
    : undefined;
}

// Instrument the adapter without changing the shared TypeScript namespace.
export function originTracingCompiler(compiler: typeof ts): typeof ts {
  const facade = Object.create(compiler) as typeof ts;
  Object.defineProperties(facade, {
    resolveModuleName: {
      value: (...arguments_: Parameters<typeof ts.resolveModuleName>) =>
        resolveModuleWithOrigin(compiler, ...arguments_),
    },
    resolveTypeReferenceDirective: {
      value: (
        ...arguments_: Parameters<typeof ts.resolveTypeReferenceDirective>
      ) => resolveTypeWithOrigin(compiler, ...arguments_),
    },
  });
  return facade;
}

function nestedRoute(
  current: ResolutionOrigin['route'],
): ResolutionOrigin['route'] {
  return current === 'incomplete' ? 'local' : current;
}

function pairReceipt(
  previous: Resolved | undefined,
  current: Resolved | undefined,
): void {
  if ([previous === undefined, current === undefined].some(Boolean)) return;
  if (
    normalizeAbsolutePath(previous!.resolvedFileName!) ===
    normalizeAbsolutePath(current!.resolvedFileName!)
  )
    previous!.resolutionOrigin = current!.resolutionOrigin;
}

function isCurrentOrigin(
  compiler: typeof ts,
  origin: ResolutionOrigin | undefined,
): boolean {
  return origin?.compiler === compiler.version && origin.route !== 'incomplete';
}
