import type { FlowWritableChunk } from './render-model';
import {
  reportIntro,
  reportOutro,
  writeReporterOutput,
} from './reporter/output';
import {
  closeFlowRenderer,
  emitFlow,
  formatReporterFailure,
} from './reporter/rendering';
import { createFlowReporterState } from './reporter/state';
import { createFlowTask } from './reporter/task';
import { createReporterTree } from './reporter/tree';
import type {
  LiminaFlowFailureOptions,
  LiminaFlowMessageOptions,
  LiminaFlowOutputOptions,
  LiminaFlowReporterOptions,
  LiminaFlowTask,
  LiminaFlowTreeNode,
} from './reporter/types';

const CHECK_FLOW_STATUS_ONLY_OPTION = Symbol('limina.checkFlowStatusOnly');

type InternalReporterOptions = LiminaFlowReporterOptions & {
  [CHECK_FLOW_STATUS_ONLY_OPTION]?: boolean;
};

export class LiminaFlowReporter {
  readonly #state;

  constructor(options: LiminaFlowReporterOptions = {}) {
    const internalOptions = options as InternalReporterOptions;
    this.#state = createFlowReporterState({
      reporterOptions: options,
      statusOnly: internalOptions[CHECK_FLOW_STATUS_ONLY_OPTION] === true,
    });
  }

  get interactive(): boolean {
    return this.#state.interactive;
  }

  get rendererBackend(): 'inline' | 'process' {
    if (this.#state.processRenderer === undefined) return 'inline';
    return 'process';
  }

  waitForRendererReady(): Promise<boolean> {
    return this.#state.processRenderer?.ready ?? Promise.resolve(false);
  }

  intro(message: string): void {
    reportIntro(this.#state, message);
  }

  outro(message: string): void {
    reportOutro(this.#state, message);
  }

  start(
    message: string,
    options: LiminaFlowMessageOptions = {},
  ): LiminaFlowTask {
    return createFlowTask({
      message,
      reporterState: this.#state,
      taskOptions: options,
    });
  }

  tree(
    message: string,
    options: LiminaFlowMessageOptions = {},
  ): LiminaFlowTreeNode {
    return createReporterTree({
      message,
      state: this.#state,
      treeOptions: options,
    });
  }

  fail(message: string, options: LiminaFlowFailureOptions = {}): void {
    emitFlow(this.#state, {
      meta: { persistInteractive: true },
      options,
      rawMessage: formatReporterFailure({
        message,
        options,
        state: this.#state,
      }),
      status: 'fail',
    });
  }

  info(message: string, options: LiminaFlowMessageOptions = {}): void {
    if (this.#state.statusOnly) return;
    emitFlow(this.#state, { options, rawMessage: message, status: 'info' });
  }

  pass(message: string, options: LiminaFlowMessageOptions = {}): void {
    emitFlow(this.#state, {
      meta: { persistInteractive: true },
      options,
      rawMessage: message,
      status: 'pass',
    });
  }

  skip(message: string, options: LiminaFlowMessageOptions = {}): void {
    emitFlow(this.#state, {
      meta: { persistInteractive: true },
      options,
      rawMessage: message,
      status: 'skip',
    });
  }

  warn(message: string, options: LiminaFlowMessageOptions = {}): void {
    if (this.#state.statusOnly) return;
    emitFlow(this.#state, {
      meta: { persistInteractive: options.persistInteractive },
      options,
      rawMessage: message,
      status: 'warn',
    });
  }

  writeOutput(
    message: FlowWritableChunk,
    options: LiminaFlowOutputOptions = {},
  ): void {
    writeReporterOutput({
      message,
      outputOptions: options,
      state: this.#state,
    });
  }

  async close(): Promise<void> {
    await closeFlowRenderer(this.#state);
  }
}

export function createLiminaFlowReporter(
  options: LiminaFlowReporterOptions = {},
): LiminaFlowReporter {
  return new LiminaFlowReporter(options);
}

export function createLiminaCheckFlowReporter(
  options: LiminaFlowReporterOptions = {},
): LiminaFlowReporter {
  return new LiminaFlowReporter({
    ...options,
    [CHECK_FLOW_STATUS_ONLY_OPTION]: true,
  } as LiminaFlowReporterOptions);
}
