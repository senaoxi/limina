import type { LiminaPreflightManager } from './manager';

export interface PreflightGenerationController {
  readonly generation: number;
  startNextGeneration(): void;
}

const generationAdvancers = new WeakMap<LiminaPreflightManager, () => void>();

export function registerPreflightGenerationAdvancer(
  preflight: LiminaPreflightManager,
  advance: () => void,
): void {
  generationAdvancers.set(preflight, advance);
}

// Execution-scheduler capability. Do not export from a barrel.
export function createPreflightGenerationController(
  preflight: LiminaPreflightManager,
): PreflightGenerationController {
  const advance = generationAdvancers.get(preflight);

  if (!advance) {
    throw new Error('Preflight manager generation controller is unavailable.');
  }

  return {
    get generation() {
      return Number(preflight.run.generation);
    },
    startNextGeneration: advance,
  };
}
