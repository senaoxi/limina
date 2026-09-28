import {
  redrawInteractiveHistory,
  stopSpinner,
  syncSpinnerTimer,
  writeControl,
} from './rendering';
import { createRenderSnapshot } from './state';
import type { FlowReporterState } from './types';

function clearInteractiveFrame(state: FlowReporterState): void {
  if (state.terminalFrame.lineCount > 0) {
    writeControl(state, `\r\u001B[${state.terminalFrame.lineCount}A\u001B[J`);
  }
  state.terminalFrame.reset();
}

function suspendProcessRenderer(
  state: FlowReporterState,
): Promise<boolean> | undefined {
  if (state.processRenderer?.active !== true) return undefined;
  return state.processRenderer.suspend();
}

export async function suspendInteractiveRendering(
  state: FlowReporterState,
): Promise<void> {
  if (!state.interactive) return;
  stopSpinner(state);
  const suspension = suspendProcessRenderer(state);
  if (suspension !== undefined) {
    await suspension;
    return;
  }
  clearInteractiveFrame(state);
}

function resumeProcessRenderer(state: FlowReporterState): boolean {
  if (state.processRenderer?.active !== true) return false;
  state.processRenderer.resume(createRenderSnapshot(state));
  return true;
}

export function resumeInteractiveRendering(state: FlowReporterState): void {
  if (!state.interactive) return;
  if (resumeProcessRenderer(state)) return;
  syncSpinnerTimer(state);
  redrawInteractiveHistory(state);
}
