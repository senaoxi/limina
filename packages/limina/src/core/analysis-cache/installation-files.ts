import { configFileStamp } from '#utils/config-file-stamp';
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
  const stamp = configFileStamp(file);
  const read = () => {
    const bytes = readFileSync(file);
    const content = inputs.observeContent({
      path: file,
      bytes,
      beforeMtime: before.mtimeMs,
      beforeStamp: stamp,
    });
    return { text: bytes.toString('utf8'), content };
  };
  const { text, content } =
    stamp === undefined
      ? read()
      : inputs.memoizeObservation(
          JSON.stringify(['installation-text', file, stamp]),
          read,
        );
  dependencies.push(content);
  return text;
}
export function readInstallationYaml(
  file: string,
  inputs: AnalysisInputs,
  dependencies: InputDependency[],
): Record<string, unknown> {
  const text = readInstallationText(file, inputs, dependencies);
  if (text === undefined) return {};
  const content = inputs.observe(file, 'content');
  const key = JSON.stringify([
    'installation-yaml',
    content.inputId,
    content.expectedVersion,
  ]);
  const parsed = inputs.memoizeObservation(
    key,
    () => parse(text) as Record<string, unknown>,
  );
  return structuredClone(parsed);
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
