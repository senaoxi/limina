import { AsyncLocalStorage } from 'node:async_hooks';
import { EpochInputReplay } from '../../core/analysis-cache/epoch-inputs';

interface ReadPhase {
  revision: number;
  replay: EpochInputReplay;
  active: boolean;
}

/**
Read-only preparation may share observations; effects always require fresh reads.
*/
export class ExecutionInputValidation {
  readonly #phase = new AsyncLocalStorage<ReadPhase>();
  #revision = 0;

  #activePhase(): ReadPhase | undefined {
    const phase = this.#phase.getStore();
    return phase?.active === true ? phase : undefined;
  }

  #readPhase(phase: ReadPhase): EpochInputReplay {
    if (phase.revision !== this.#revision) {
      phase.revision = this.#revision;
      phase.replay = new EpochInputReplay();
    }
    return phase.replay;
  }

  invalidate(): void {
    this.#revision += 1;
  }

  read(shouldRefresh?: boolean): EpochInputReplay {
    if (shouldRefresh) {
      this.invalidate();
      return new EpochInputReplay();
    }
    const phase = this.#activePhase();
    return phase === undefined
      ? new EpochInputReplay()
      : this.#readPhase(phase);
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.#activePhase() !== undefined) return action();
    const phase = {
      revision: this.#revision,
      replay: new EpochInputReplay(),
      active: true,
    };
    try {
      return await this.#phase.run(phase, action);
    } finally {
      phase.active = false;
    }
  }
}
