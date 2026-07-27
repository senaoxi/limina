import type { InteractiveEntryReference } from './types';

export interface FlowTaskState {
  completed: boolean;
  depth: number;
  message: string;
  persistedStart: InteractiveEntryReference | undefined;
  processTransientTaskId: number | undefined;
  shouldTrack: boolean;
  startLine: number;
  startTime: number;
}
