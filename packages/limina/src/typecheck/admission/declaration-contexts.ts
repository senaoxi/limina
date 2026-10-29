import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { resolveVueSemanticToolchain } from '../../checker/vue-semantic-toolchain';
import type { GeneratedTsconfigGraphResult } from '../../core/build-graph/types';
import { nativeFingerprint } from '../../core/typescript-semantic/native-file-identity';
import type { TypecheckTarget } from '../target-types';
import type { ExecutionReferenceClosure } from './reference-closure';

const requireFromLimina = createRequire(import.meta.url);

/**
Only the matching concrete checker build command can redeem a context receipt.
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
  if (target === undefined || !hasQualifiedBuildArguments(target))
    return [
      'Declaration contexts require a qualified checker build target; command overrides are not qualified.',
    ];
  if (analysis?.declarationValidation?.state !== 'admitted')
    return ['Declaration candidate validation is not admitted.'];
  const executed = closure.executedConfigs;
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
        receipt.version === 3 &&
        executed.has(receipt.generatedConfig) &&
        receipt.contextId.length > 0 &&
        receipt.sourceConfig === config &&
        receipt.authority.executionEntry === target.args[0] &&
        hasMatchingAuthority(receipt, target),
    )
      ? []
      : [
          `Declaration checking is not bound to the actual build closure: ${config}`,
        ],
  );
}

function hasQualifiedBuildArguments(target: TypecheckTarget): boolean {
  const [, build, config, ...flags] = target.args;
  if (
    config === undefined ||
    build !== '-b' ||
    target.command !== process.execPath ||
    path.resolve(target.executionRootDir ?? target.cwd, config) !==
      path.resolve(target.configPath)
  )
    return false;
  // These are the concrete adapter's build/watch dialects. Other CLI options
  // can change checking responsibility even when entry and config still match.
  return [
    ['--pretty', 'false'],
    ['--pretty', 'false', '--watch', '--preserveWatchOutput'],
  ].some((expected) => JSON.stringify(flags) === JSON.stringify(expected));
}

function hasMatchingAuthority(
  receipt: NonNullable<
    NonNullable<
      GeneratedTsconfigGraphResult['dependencyAnalysis']
    >['declarationValidation']
  >['receipts'][number],
  target: TypecheckTarget,
): boolean {
  if (receipt.authority.adapter === 'typescript-declaration-candidate-v1')
    return (
      receipt.checker === target.checkerName &&
      receipt.compilerVersion === ts.version &&
      target.args[0] === requireFromLimina.resolve('typescript/bin/tsc') &&
      receipt.authority.toolchain ===
        nativeFingerprint([requireFromLimina.resolve('typescript'), ts.version])
    );
  if (receipt.authority.adapter !== 'vue-cli-declaration-candidate-v1')
    return false;
  try {
    const toolchain = resolveVueSemanticToolchain(
      target.executionRootDir ?? target.cwd,
    );
    return (
      receipt.checker === target.checkerName &&
      receipt.compilerVersion === toolchain.versions.typeScript &&
      receipt.authority.toolchain ===
        nativeFingerprint([toolchain.paths, toolchain.versions])
    );
  } catch {
    return false;
  }
}
