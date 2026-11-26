import { AsyncLocalStorage } from 'node:async_hooks';

export interface ResolvedConfigCacheRequest {
  readonly configPath: string;
  readonly key: string;
}

type LiveConfigParser = <T>(
  parse: () => T,
  key: string | undefined,
  projection?: ResolvedConfigCacheRequest,
) => T;

const parsers = new AsyncLocalStorage<LiveConfigParser>();

export function withLiveConfigParser<T>(
  parser: LiveConfigParser,
  operation: () => T,
): T {
  return parsers.run(parser, operation);
}

export function parseLiveConfig<T>(
  operation: () => T,
  key?: string,
  projection?: ResolvedConfigCacheRequest,
): T {
  const parser = parsers.getStore();
  return parser === undefined
    ? operation()
    : parser(operation, key, projection);
}
