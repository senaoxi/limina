import type { cac } from 'cac';
import { isRunProofCheck } from '../../commands/proof';
import { LiminaPreflightManager } from '../../preflight';
import type { LiminaCheckIssue } from '../../source-check/snapshot';
import { loadStandaloneContext } from '../command-runtime';
import { createCliFlow } from '../flow';
import { isRunStandaloneIssueFlow } from '../standalone';
import type { ProofFlags } from '../types';

type LiminaCli = ReturnType<typeof cac>;

function assertProofAction(action: string): void {
  if (action === 'check') return;
  throw new Error(`Unknown proof action "${action}". Expected check.`);
}

async function runProofAction(
  action: string,
  flags: ProofFlags,
): Promise<void> {
  assertProofAction(action);
  const flow = createCliFlow();
  const isPassed = await isRunStandaloneIssueFlow({
    execute: async (registerSession) => {
      flow.intro('limina proof check');
      const { commandContext, config } = await loadStandaloneContext(
        flags,
        'proof',
      );
      const preflight = new LiminaPreflightManager({ config });
      const issues: LiminaCheckIssue[] = [];
      registerSession({
        command: 'limina proof check',
        commandContext,
        config,
        issues,
        preflight,
        task: 'proof:check',
        title: 'Proof check',
      });
      return isRunProofCheck(config, {
        clearScreen: false,
        deferSnapshot: true,
        flow,
        issues,
        preflight,
        report: {
          command: 'limina proof check',
          verbose: flags.verbose,
        },
      });
    },
    flow,
    messages: {
      failed: 'limina proof failed',
      passed: 'limina proof passed',
    },
  });
  if (!isPassed) process.exitCode = 1;
}

export function registerProofCommand(cli: LiminaCli): void {
  cli
    .command('proof <action>', 'Check root typecheck coverage proof')
    .option('--verbose', 'Show full proof check issue details')
    .action(runProofAction);
}
