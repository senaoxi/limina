import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function object(value: unknown): Record<string, unknown> {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected an object',
  );
  return value as Record<string, unknown>;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  }
  const encoded = JSON.stringify(value);
  invariant(encoded !== undefined, 'Cannot hash an undefined value');
  return encoded;
}
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function hashObject(value: unknown): string {
  return digest(canonical(value));
}
export function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
export function outputs(values: Record<string, string>): void {
  invariant(
    JSON.stringify(values).length * 2 <= 64 * 1024,
    'CI job outputs exceed 64 KiB',
  );
  const destination = process.env.GITHUB_OUTPUT;
  invariant(destination, 'GITHUB_OUTPUT is required');
  for (const [key, value] of Object.entries(values)) {
    invariant(
      /^[a-z][a-z0-9_]*$/.test(key) && !/[\r\n]/.test(value),
      'Invalid CI output',
    );
    appendFileSync(destination, key + '=' + value + '\n');
  }
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown CI failure';
}
export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  invariant(value, 'Missing environment variable: ' + name);
  return value;
}
export function positiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  invariant(Number.isSafeInteger(number) && number > 0, 'Invalid ' + name);
  return number;
}
export function sha(value: unknown): string {
  invariant(
    typeof value === 'string' && /^[a-f0-9]{40}$/.test(value),
    'Expected a complete Git SHA',
  );
  return value;
}
