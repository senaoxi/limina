import type { TaskDefinition } from '../../controller/calibration.ts';
import { gradeDeclarationConditionsV21 } from '../v2_1/R02.ts';

/**
The native oracle and the actual Checker must reject the same consumer.
*/
export const gradeDeclarationConditions: TaskDefinition['grade'] = async (
  task,
  fixture,
  final,
  verifier,
) => {
  const result = await gradeDeclarationConditionsV21(
    task,
    fixture,
    final,
    verifier,
  );
  if (result.report.status !== 'complete') return result;
  // The preceding grader has installed the independent wrong-return-type control.
  const rejected = await verifier.command('/usr/local/bin/node', [
    '/opt/limina-evals/runtime/node_modules/limina/bin/limina.js',
    'checker',
    'build',
  ]);
  result.commands.push(rejected);
  result.report.assertions.push({
    id: 'checker-declaration-diagnostic',
    passed:
      rejected.exitCode === 1 &&
      /consumer\/index\.ts\([^)]*\): error TS2322:/u.test(
        `${rejected.stdout}\n${rejected.stderr}`,
      ),
  });
  if (rejected.timedOut || rejected.exitCode === null)
    result.report.status = 'error';
  return result;
};
