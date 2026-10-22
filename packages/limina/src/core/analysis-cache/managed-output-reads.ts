import type { AnalysisRead } from '#utils/analysis-input';
import path from 'pathe';

function isDirectoryObservation(input: AnalysisRead): boolean {
  return input.descriptor?.kind === 'directory' && input.value === true;
}
export function isAffectedByOutput(input: AnalysisRead, file: string): boolean {
  return (
    input.path === file ||
    (!isDirectoryObservation(input) && isDescendantObservation(input, file))
  );
}
function isDescendantObservation(input: AnalysisRead, file: string): boolean {
  return (
    hasDirectoryDescriptor(input) &&
    file.startsWith(`${input.path.replace(/\/$/u, '')}/`)
  );
}
function isCreatedDirectory(input: AnalysisRead, value: unknown): boolean {
  return [
    input.descriptor?.kind === 'directory',
    input.value === false,
    value === true,
  ].every(Boolean);
}
function hasWrittenDescendant(
  file: string,
  outputs: ReadonlySet<string>,
): boolean {
  return [...outputs].some((output) => output.startsWith(`${file}/`));
}
function isOutputMember(
  input: AnalysisRead,
  entry: string,
  outputs: ReadonlySet<string>,
): boolean {
  const file = path.isAbsolute(entry) ? entry : path.resolve(input.path, entry);
  return outputs.has(file) || isWrittenDirectory(input, file, outputs);
}
function isWrittenDirectory(
  input: AnalysisRead,
  file: string,
  outputs: ReadonlySet<string>,
): boolean {
  return (
    input.descriptor?.kind === 'directories' &&
    hasWrittenDescendant(file, outputs)
  );
}
function isMembershipChange(
  input: AnalysisRead,
  value: unknown,
  outputs: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(input.value) || !Array.isArray(value)) return false;
  const change = { input, before: input.value, after: value };
  return isManagedMembership(change, outputs);
}
function isManagedMembership(
  change: { input: AnalysisRead; before: string[]; after: string[] },
  outputs: ReadonlySet<string>,
): boolean {
  if (!hasEnumerationDescriptor(change.input)) return false;
  const changed = new Set(change.before).symmetricDifference(
    new Set(change.after),
  );
  return (
    changed.size > 0 &&
    [...changed].every((entry) => isOutputMember(change.input, entry, outputs))
  );
}
export function isManagedChange(
  input: AnalysisRead,
  value: unknown,
  outputs?: ReadonlySet<string>,
): boolean {
  return outputs !== undefined && isManagedPathChange(input, value, outputs);
}
function isManagedDescendantChange(
  input: AnalysisRead,
  value: unknown,
  outputs: ReadonlySet<string>,
): boolean {
  return isCreatedDirectory(input, value)
    ? hasWrittenDescendant(input.path, outputs)
    : isMembershipChange(input, value, outputs);
}

function hasDirectoryDescriptor(input: AnalysisRead): boolean {
  return ['directories', 'directory', 'glob', 'ts-directory'].includes(
    input.descriptor?.kind ?? '',
  );
}
function hasEnumerationDescriptor(input: AnalysisRead): boolean {
  return ['directories', 'glob', 'ts-directory'].includes(
    input.descriptor?.kind ?? '',
  );
}
function isManagedPathChange(
  input: AnalysisRead,
  value: unknown,
  outputs: ReadonlySet<string>,
): boolean {
  return (
    outputs.has(input.path) || isManagedDescendantChange(input, value, outputs)
  );
}
