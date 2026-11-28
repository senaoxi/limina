import { createHash } from 'node:crypto';

const trueVersion = hashJson('true');
const falseVersion = hashJson('false');

export function analysisHash(value: unknown): string {
  if (typeof value === 'boolean') return value ? trueVersion : falseVersion;
  return hashJson(JSON.stringify(value) ?? 'undefined');
}

function hashJson(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
