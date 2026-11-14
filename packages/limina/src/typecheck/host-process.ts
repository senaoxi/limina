import {
  type CheckerHostRequest,
  type CheckerHostResponse,
  spawnInheritedChecker,
} from './host-protocol';
import { terminateSupervisorProcessGroup } from './process-tree';

const state = { hasLaunched: false, isTerminating: false };

function cleanup(): void {
  if (state.isTerminating) return;
  state.isTerminating = true;
  terminateSupervisorProcessGroup();
}

function send(message: CheckerHostResponse, onSent?: () => void): void {
  if (state.isTerminating) return;
  try {
    if (process.send === undefined) {
      cleanup();
      return;
    }
    process.send(message, (error: Error | null) => {
      if (error !== null) cleanup();
      else if (!state.isTerminating) onSent?.();
    });
  } catch {
    cleanup();
  }
}

process.on('message', async (request: CheckerHostRequest) => {
  if (state.isTerminating) return;
  if (state.hasLaunched || request?.type !== 'spawn') {
    cleanup();
    return;
  }
  state.hasLaunched = true;
  const result = await spawnInheritedChecker(request);
  send(result, () => {
    process.exit(0);
  });
});
process.on('disconnect', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
send({ type: 'ready' });
