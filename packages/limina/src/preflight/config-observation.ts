import type { ResolvedLiminaConfig } from '#config/runner';
import { getConfigBindings } from '../config/input-observation';
import { pathBinding } from '../core/analysis-cache/directory-fingerprint';
import { analysisHash } from '../core/analysis-cache/identity';
import {
  assertGovernanceBinding,
  configInputs,
  readConfigInput,
} from './analysis-cache-identity';

/**
Invocation validity is independent of persistent cache read/write policy.
*/
export class ConfigObservation {
  readonly #config: ResolvedLiminaConfig;
  readonly #inputs: Map<string, string | null>;
  readonly #bindings: Map<string, string>;

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
  }

  assertStable(): void {
    assertGovernanceBinding(this.#config);
    for (const [file, text] of this.#inputs) {
      const isCurrent = [
        readConfigInput(file) === text,
        analysisHash(pathBinding(file)) === this.#bindings.get(file),
      ].every(Boolean);
      if (!isCurrent)
        throw new Error(
          `Limina configuration or governance root changed during execution: ${file}. Run the command again to load the new configuration.`,
        );
    }
  }
}
