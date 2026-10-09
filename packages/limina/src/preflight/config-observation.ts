import type { ResolvedLiminaConfig } from '#config/runner';
import { readFileSync } from 'node:fs';
import {
  type ConfigModuleEvidence,
  getConfigBindings,
} from '../config/input-observation';
import { assertConfigRequestBindings } from '../config/load-evidence';
import type { ConfigModuleSnapshot } from '../core/analysis-cache/contracts';
import { pathBinding } from '../core/analysis-cache/directory-fingerprint';
import { analysisHash } from '../core/analysis-cache/identity';
import {
  assertGovernanceBinding,
  configInputs,
  readConfigInput,
} from './analysis-cache-identity';
import { warnConfigModuleCoverage } from './config-module-diagnostics';
import { configModuleEvidence } from './config-module-evidence';
import { captureConfigModuleSnapshot } from './config-module-snapshot';

/**
Invocation validity is independent of persistent cache read/write policy.
*/
export class ConfigObservation {
  readonly #config: ResolvedLiminaConfig;
  readonly #inputs: Map<string, string | null>;
  readonly #bindings: Map<string, string>;
  readonly #evidence: ConfigModuleEvidence;
  #snapshot: ConfigModuleSnapshot | undefined;
  constructor(config: ResolvedLiminaConfig) {
    this.#config = config;
    assertGovernanceBinding(config);
    this.#inputs = configInputs(config);
    const loaded = getConfigBindings(config);
    this.#bindings = new Map(
      this.#inputs
        .keys()
        .map((file): [string, string] => [
          file,
          loaded?.get(file) ?? analysisHash(pathBinding(file)),
        ]),
    );
    this.#evidence = configModuleEvidence(config, this.#inputs, this.#bindings);
  }
  get metrics(): Readonly<Record<string, number>> {
    return this.#evidence.metrics;
  }
  snapshot(previous?: ConfigModuleSnapshot): ConfigModuleSnapshot {
    if (this.#snapshot !== undefined) return this.#snapshot;
    this.#snapshot = captureConfigModuleSnapshot(this.#evidence, previous);
    warnConfigModuleCoverage(this.#evidence, this.#snapshot);
    return this.#snapshot;
  }
  assertStable(): void {
    assertGovernanceBinding(this.#config);
    for (const [file, text] of this.#inputs)
      assertInputStable(
        { file, text, binding: this.#bindings.get(file) },
        this.#evidence,
      );
    assertConfigRequestBindings(this.#evidence);
  }
}
interface ObservedInput {
  file: string;
  text: string | null;
  binding: string | undefined;
}
function assertInputStable(
  input: ObservedInput,
  evidence: ConfigModuleEvidence,
): void {
  evidence.metrics.executionValidationReads =
    (evidence.metrics.executionValidationReads ?? 0) + 1;
  const isCurrent = [
    isCurrentContent(input, evidence),
    analysisHash(pathBinding(input.file)) === input.binding,
  ].every(Boolean);
  if (!isCurrent)
    throw new Error(
      `Limina configuration or governance root changed during execution: ${input.file}. Run the command again to load the new configuration.`,
    );
}
function isCurrentContent(
  input: ObservedInput,
  evidence: ConfigModuleEvidence,
): boolean {
  const bytes = evidence.bytes.get(input.file);
  return bytes === undefined
    ? readConfigInput(input.file) === input.text
    : isCurrentBytes(input.file, bytes);
}
function isCurrentBytes(file: string, bytes: Buffer): boolean {
  return currentBytes(file)?.equals(bytes) ?? false;
}
function currentBytes(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
