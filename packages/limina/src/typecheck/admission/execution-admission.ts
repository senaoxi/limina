import { compareCodeUnits } from '#utils/collections';
import { readFileSync } from 'node:fs';
import { withMaterializedPlanReadLease } from '../../core/build-graph/materialization-read-lease';
import type { GeneratedTsconfigGraphResult } from '../../core/build-graph/types';
import type { GraphFinding } from '../../graph-check/findings';
import { adjudicateReferences } from '../../graph-check/reference-governance';
import type { LiminaPreflightManager } from '../../preflight';
import type { TypecheckTarget } from '../targets';
import { executionCompilationDiagnostics } from './compilation';
import {
  assertExecutionPermit,
  InvalidExecutionPermit,
  type PermitAuthority,
  type PermitBinding,
  withExecutionPermit,
} from './execution-permit';
import {
  executionInputCoordinator,
  type ExecutionInputCoordinator,
} from './input-coordinator';
import { collectExecutionReferenceClosure } from './reference-closure';
import { assertTargetIdentity, captureTarget } from './target-identity';
import type {
  AuthorizedResult,
  ExecutionAdmissionDiagnostic,
  ExecutionPermit,
  ExecutionStage,
} from './types';

interface Refusal {
  decision: 'denied' | 'unavailable';
  diagnostics: ExecutionAdmissionDiagnostic[];
}
function normalizeAuthorization(authorization: PermitAuthority): {
  stage: ExecutionStage;
  authority?: object;
} {
  return typeof authorization === 'string'
    ? { stage: authorization }
    : authorization;
}
function rethrowLaunchedError(input: {
  isStarted: boolean;
  stage: ExecutionStage;
  error: unknown;
}): void {
  if (
    [
      input.isStarted,
      input.stage === 'launch',
      !(input.error instanceof InvalidExecutionPermit),
    ].every(Boolean)
  )
    throw input.error;
}
function diagnostic(finding: GraphFinding): ExecutionAdmissionDiagnostic {
  const { task, ...details } = finding;
  if (task !== 'graph:check')
    throw new Error('Invalid governance finding producer.');
  return {
    code: finding.code,
    message: finding.presentation.detailLines.join('\n'),
    finding: details as Omit<GraphFinding, 'task'>,
  };
}
function inputRefusal(error: unknown): Refusal {
  return {
    decision: 'unavailable',
    diagnostics: [
      {
        code: 'LIMINA_EXECUTION_INPUT_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}
function refused(
  target: TypecheckTarget,
  stage: ExecutionStage,
  refusal: Refusal,
): AuthorizedResult<never> {
  return {
    state: 'refused',
    rejection: {
      status: 'admission-rejected',
      id: target.id,
      stage,
      ...refusal,
    },
  };
}
function assertMaterializedInput(
  graph: GeneratedTsconfigGraphResult,
  file: string,
): void {
  const expected = graph.generatedFiles.get(file);
  if (expected === undefined) return;
  if (readFileSync(file, 'utf8') !== expected)
    throw new Error(`Materialized execution configuration changed: ${file}`);
}
/**
An authorization is usable only inside this module's checked callback.
*/
export class ExecutionAdmission {
  readonly #permitOwner = Object.freeze({});
  readonly #targets = new Map<string, string | Error>();
  readonly #inputs: ExecutionInputCoordinator;
  readonly #selection: readonly TypecheckTarget[];
  readonly #selectionIds: string;
  readonly preflight: LiminaPreflightManager;
  constructor(
    preflight: LiminaPreflightManager,
    graph: GeneratedTsconfigGraphResult,
    targets: readonly TypecheckTarget[],
  ) {
    this.preflight = preflight;
    this.#selection = targets;
    this.#selectionIds = JSON.stringify(targets);
    this.#inputs = executionInputCoordinator(preflight, graph);
    for (const target of targets)
      this.#targets.set(
        target.id,
        captureTarget(target, graph, preflight.config.rootDir),
      );
  }
  async #assertSelection(target: TypecheckTarget): Promise<void> {
    if (this.#selectionIds !== JSON.stringify(this.#selection))
      throw new Error('Execution target selection changed.');
    this.preflight.assertExecutionConfigurationStable();
    this.#inputs.assertLifecycle();
    assertTargetIdentity(
      this.#targets.get(target.id),
      captureTarget(target, this.graph, this.preflight.config.rootDir),
    );
    if ((await this.preflight.ensureGeneratedGraph()) !== this.graph)
      throw new Error('Execution graph changed.');
  }
  async #check(target: TypecheckTarget): Promise<Refusal | undefined> {
    const closure = await this.#currentInputs(target);
    return (
      this.#govern(closure.governed) ??
      executionCompilationDiagnostics(this.graph, closure)
    );
  }
  async #currentInputs(target: TypecheckTarget) {
    await this.#assertSelection(target);
    await this.#inputs.validate(target);
    const closure = collectExecutionReferenceClosure(
      this.graph,
      target,
      this.preflight.config,
    );
    for (const file of closure.inputs)
      assertMaterializedInput(this.graph, file);
    return closure;
  }
  #govern(
    references: ReturnType<typeof collectExecutionReferenceClosure>['governed'],
  ): Refusal | undefined {
    for (const { reference, aliases } of references) {
      const verdict = adjudicateReferences({
        config: this.preflight.config,
        aliases,
        references: [reference],
      });
      if (verdict.state !== 'clear')
        return {
          decision: verdict.state,
          diagnostics: verdict.findings.map(diagnostic),
        };
    }
    return undefined;
  }
  #permitBinding(
    target: TypecheckTarget,
    authorization: PermitAuthority,
  ): PermitBinding {
    const { stage, authority } = normalizeAuthorization(authorization);
    return {
      owner: this.#permitOwner,
      target: target.id,
      stage,
      authority,
      graph: this.graph,
      providers: this.preflight.providers,
      namespace: this.preflight.artifactNamespace,
      snapshot: this.preflight.run.snapshotToken,
      binding: this.#binding(target, authority),
    };
  }
  #binding(target: TypecheckTarget, authority?: object): string {
    const closure = collectExecutionReferenceClosure(
      this.graph,
      target,
      this.preflight.config,
    );
    return JSON.stringify([
      captureTarget(target, this.graph, this.preflight.config.rootDir),
      this.graph.artifactPlan.desiredRevision,
      closure.references,
      [...closure.inputs].sort(compareCodeUnits),
      [...(closure.observations?.paths ?? [])].sort(compareCodeUnits),
      authority,
    ]);
  }
  async assertPermit(
    permit: ExecutionPermit,
    target: TypecheckTarget,
    authorization: PermitAuthority,
  ): Promise<void> {
    try {
      assertExecutionPermit(permit, this.#permitBinding(target, authorization));
      const refusal = await this.#check(target);
      assertNoRefusal(refusal);
      assertExecutionPermit(permit, this.#permitBinding(target, authorization));
    } catch (error) {
      throw new InvalidExecutionPermit(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  get graph(): GeneratedTsconfigGraphResult {
    return this.#inputs.graph;
  }
  /**
  Read-only capability proof survives governance refusal; it grants no mutation or launch permit.
  */
  async withTargetEvidence<T>(
    target: TypecheckTarget,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.withManagedWrites(target, new Set(), () =>
      withMaterializedPlanReadLease(
        this.preflight.artifactNamespace,
        this.graph.artifactPlan,
        async () => {
          await this.#currentInputs(target);
          return action();
        },
      ),
    );
  }
  async withAuthorizedTarget<T>(
    target: TypecheckTarget,
    authorization: PermitAuthority,
    action: (permit: ExecutionPermit) => Promise<T>,
  ): Promise<AuthorizedResult<T>> {
    if (!this.#inputs.isReserved(target))
      return this.#inputs.withManagedWrites(target, new Set(), () =>
        this.withAuthorizedTarget(target, authorization, action),
      );
    const { stage } = normalizeAuthorization(authorization);
    let isStarted = false;
    try {
      return await withMaterializedPlanReadLease(
        this.preflight.artifactNamespace,
        this.graph.artifactPlan,
        async () => {
          const refusal = await this.#check(target);
          if (refusal !== undefined) return refused(target, stage, refusal);
          isStarted = true;
          return {
            state: 'executed',
            value: await withExecutionPermit(
              this.#permitBinding(target, authorization),
              action,
            ),
          };
        },
      );
    } catch (error) {
      rethrowLaunchedError({ isStarted, stage, error });
      return refused(target, stage, inputRefusal(error));
    }
  }
  async withManagedWrites<T>(
    target: TypecheckTarget,
    outputs: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>),
    action: (
      recordWrites: () => void,
      releaseAtLaunch: () => void,
    ) => Promise<T>,
  ): Promise<T> {
    return this.#inputs.withManagedWrites(target, outputs, action);
  }
}

function assertNoRefusal(refusal: Refusal | undefined): void {
  if (refusal !== undefined)
    throw new Error(refusal.diagnostics.map((item) => item.message).join('\n'));
}
