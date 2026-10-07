import { parse as parseIni } from 'ini';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { InputDependency } from './contracts';
import { inputStat, isRegularFile } from './input-state';
import type { AnalysisInputs } from './inputs';

export function readInstallationText(
  file: string,
  inputs: AnalysisInputs,
  dependencies: InputDependency[],
): string | undefined {
  dependencies.push(
    inputs.observe(file, 'file'),
    inputs.observe(file, 'binding'),
  );
  const before = inputStat(file);
  if (!isRegularFile(before)) return undefined;
  const checkedAt = Date.now();
  const text = readFileSync(file, 'utf8');
  const content = inputs.observeText({
    path: file,
    text,
    checkedAt,
    beforeMtime: before.mtimeMs,
  });
  // The existing manifest classifier already revokes the whole domain for
  // non imports/exports changes. Do not add a third field optimization.
  if (!file.endsWith('/package.json')) dependencies.push(content);
  return text;
}
export function readInstallationYaml(
  file: string,
  inputs: AnalysisInputs,
  dependencies: InputDependency[],
): Record<string, unknown> {
  const text = readInstallationText(file, inputs, dependencies);
  return text === undefined ? {} : (parse(text) as Record<string, unknown>);
}
export function requireInstallationManifest(
  file: string,
  inputs: AnalysisInputs,
  dependencies: InputDependency[],
): Record<string, unknown> {
  const text = readInstallationText(file, inputs, dependencies);
  if (text === undefined)
    throw new Error(`Installation manifest missing: ${file}`);
  return JSON.parse(text) as Record<string, unknown>;
}
export function npmSetting(text: string, name: string): string | undefined {
  const value = parseIni(text)[name];
  return value === undefined ? undefined : String(value);
}
