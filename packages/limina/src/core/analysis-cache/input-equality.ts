import type { AnalysisInput } from './contracts';
import { analysisHash } from './identity';
import { inputStat } from './input-state';
export function retainedInput(
  previous: AnalysisInput | undefined,
  next: AnalysisInput,
): AnalysisInput {
  return isSameInput(previous, next) ? previous! : next;
}
function isSameInput(
  previous: AnalysisInput | undefined,
  next: AnalysisInput,
): boolean {
  if (previous === undefined) return false;
  const keys = new Set(
    [...Object.keys(previous), ...Object.keys(next)].filter(
      (key) => key !== 'verifiedThrough',
    ),
  );
  return [...keys].every((key) =>
    isSameValue(
      previous[key as keyof AnalysisInput],
      next[key as keyof AnalysisInput],
    ),
  );
}
function isSameValue(before: unknown, after: unknown): boolean {
  return before === after || analysisHash(before) === analysisHash(after);
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
export function hasMtime(path: string, mtime: number): boolean {
  return inputStat(path)?.mtimeMs === mtime;
}
