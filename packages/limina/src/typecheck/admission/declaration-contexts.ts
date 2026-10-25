import { createRequire } from 'node:module';
import ts from 'typescript';
import type { GeneratedTsconfigGraphResult } from '../../core/build-graph/types';
import type { TypecheckTarget } from '../target-types';
import type { ExecutionReferenceClosure } from './reference-closure';

const requireFromLimina = createRequire(import.meta.url);

/**
Only the concrete native build command can redeem a tsc context receipt.
*/
export function declarationExecutionGaps(
  graph: GeneratedTsconfigGraphResult,
  closure: ExecutionReferenceClosure,
  target: TypecheckTarget | undefined,
): string[] {
  const analysis = graph.dependencyAnalysis;
  const decisions = (analysis?.declarationContexts ?? []).filter((decision) =>
    closure.configs.has(decision.consumerConfig),
  );
  if (decisions.length === 0) return [];
  if (
    target === undefined ||
    target.command !== process.execPath ||
    target.args[0] !== requireFromLimina.resolve('typescript/bin/tsc') ||
    !target.args.includes('-b')
  )
    return [
      'Declaration contexts require the qualified native tsc build target; command overrides are not qualified.',
    ];
  const receipts = analysis?.declarationValidation?.receipts ?? [];
  const required = new Set(
    decisions.flatMap((decision) =>
      decision.selection.state === 'selected'
        ? [decision.consumerConfig, decision.selection.config]
        : [decision.consumerConfig],
    ),
  );
  return [...required].flatMap((config) =>
    closure.configs.has(config) &&
    receipts.some(
      (receipt) =>
        receipt.version === 2 &&
        receipt.contextId.length > 0 &&
        receipt.sourceConfig === config &&
        receipt.checker === 'tsc' &&
        receipt.compilerVersion === ts.version,
    )
      ? []
      : [
          `Declaration checking is not bound to the actual build closure: ${config}`,
        ],
  );
}
