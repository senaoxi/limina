import { type BankRevision, isBankRevision } from '../core/task-bank.ts';
import { availableDevelopmentTasks } from './index.ts';
import { availableV2DevelopmentTasks } from './v2/index.ts';
import { availableV21DevelopmentTasks } from './v2_1/index.ts';
import { availableV22DevelopmentTasks } from './v2_2/index.ts';

const developmentTasks = {
  v1: availableDevelopmentTasks,
  v2: availableV2DevelopmentTasks,
  'v2.1': availableV21DevelopmentTasks,
  'v2.2': availableV22DevelopmentTasks,
} satisfies Record<BankRevision, typeof availableDevelopmentTasks>;

/**
Bank revision is independent of TaskSpec's schema version. Never fall back.
*/
export function developmentTasksForRevision(revision: BankRevision) {
  if (!isBankRevision(revision))
    throw new Error('Unsupported task bank revision');
  return developmentTasks[revision];
}
