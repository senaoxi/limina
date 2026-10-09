import { normalizeAbsolutePath } from '#utils/path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

function removeParameter(query: string, parameter: string): string {
  const parts = query.replace(/^\?/u, '').split('&');
  const index = parts.lastIndexOf(parameter);
  if (index !== -1) parts.splice(index, 1);
  return parts.join('&');
}
function canObserveEsm(url: string, conditions: readonly string[]): boolean {
  return url.startsWith('file:') && !conditions.includes('require');
}
/**
Normalize only tokens owned by this load; user queries and fragments survive.
*/
export class ConfigLoadURLs {
  readonly #token = randomUUID();
  readonly #originals = new Map<string, string>();
  readonly namespace: string | undefined;
  constructor(namespace?: string) {
    this.namespace = namespace;
  }

  #cjsPath(value: string): string {
    if (this.namespace === undefined) return value;
    const suffix = `?namespace=${this.namespace}`;
    return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
  }
  #query(query: string): string {
    const own = removeParameter(query, `liminaConfig=${this.#token}`);
    return this.namespace === undefined
      ? own
      : removeParameter(own, `tsx-namespace=${this.namespace}`);
  }
  #fileOriginal(value: string): string {
    const url = new URL(value);
    const result = pathToFileURL(this.#cjsPath(fileURLToPath(url)));
    result.search = this.#query(url.search);
    result.hash = url.hash;
    return result.href;
  }
  #shouldIsolate(url: string, conditions: readonly string[]): boolean {
    return (
      this.namespace === undefined &&
      !this.#originals.has(url) &&
      canObserveEsm(url, conditions)
    );
  }

  original(value: string): string {
    const original = this.#originals.get(value) ?? value;
    return original.startsWith('file:')
      ? this.#fileOriginal(original)
      : this.#cjsPath(original);
  }

  /**
  Observe ESM even when CLI initialization already imported its library.
  */
  observedResult<T extends { url: string }>(
    result: T,
    conditions: readonly string[],
  ): T {
    if (!this.#shouldIsolate(result.url, conditions)) return result;
    const url = new URL(result.url);
    url.search += `${url.search === '' ? '?' : '&'}liminaConfig=${this.#token}`;
    this.#originals.set(url.href, result.url);
    return { ...result, url: url.href };
  }

  physicalPath(value: string | undefined): string | undefined {
    return value?.startsWith('file:')
      ? normalizeAbsolutePath(fileURLToPath(this.original(value)))
      : undefined;
  }
}
