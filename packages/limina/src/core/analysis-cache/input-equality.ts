import { isDeepStrictEqual } from 'node:util';
import type { AnalysisInput } from './contracts';
export function retainedInput(
  previous: AnalysisInput | undefined,
  next: AnalysisInput,
): AnalysisInput {
  return previous !== undefined && isDeepStrictEqual(previous, next)
    ? previous
    : next;
}

export function hasChangedBytes(
  previous: AnalysisInput | undefined,
  input: AnalysisInput,
): boolean {
  return [
    input.kind === 'bytes',
    previous !== undefined,
    previous?.version !== input.version,
  ].every(Boolean);
}
