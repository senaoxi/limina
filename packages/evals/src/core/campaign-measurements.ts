import assert from 'node:assert/strict';
import {
  apiPricingIdentity,
  resolveApiPricing,
  type TraceCost,
} from './estimated-cost.ts';
import type { ExperimentManifest } from './experiment.ts';
import { contentIdentity } from './identity.ts';
import type { AttemptRecord } from './run-store.ts';

export interface AttemptCost extends TraceCost {
  runId: string;
  experimentIdentity: string;
  taskId: string;
  condition: string;
  repetition: number;
  traceSha256: string | null;
}

interface Cell {
  attempts: readonly AttemptRecord[];
}

/**
Means weight task/condition cells equally; coverage always counts physical executions.
*/
function measurement(
  cells: Cell[],
  value: (a: AttemptRecord) => number | null,
  observed: (a: AttemptRecord) => number | null = value,
) {
  const means: number[] = [];
  let measured = 0;
  let executions = 0;
  let observedSum = 0;
  for (const cell of cells) {
    const values: number[] = [];
    for (const a of cell.attempts) {
      executions++;
      const v = value(a);
      const sum = observed(a);
      for (const n of [v, sum])
        assert.ok(
          n === null || (Number.isFinite(n) && n >= 0),
          'Invalid measurement',
        );
      if (sum !== null) observedSum += sum;
      if (v !== null) values.push(v);
    }
    measured += values.length;
    if (values.length > 0)
      means.push(values.reduce((s, n) => s + n, 0) / values.length);
  }
  return {
    mean:
      means.length > 0 ? means.reduce((s, n) => s + n, 0) / means.length : null,
    observedSum,
    total: measured === executions && executions > 0 ? observedSum : null,
    measured,
    executions,
    coverage: executions ? measured / executions : 0,
    cells: cells.length,
    measuredCells: means.length,
  };
}

export function buildCampaignMeasurements(
  manifest: ExperimentManifest,
  attempts: readonly AttemptRecord[],
  costs: readonly AttemptCost[],
  pricingIdentity = apiPricingIdentity,
  version: 1 | 2 = 2,
) {
  assert.ok(version === 1 || version === 2, 'Unsupported measurement version');
  const pricing = resolveApiPricing(pricingIdentity);
  const costByRun = new Map(costs.map((c) => [c.runId, c]));
  assert.equal(costByRun.size, costs.length, 'Duplicate cost attempt');
  assert.equal(
    new Set(attempts.map((a) => a.runId)).size,
    attempts.length,
    'Duplicate measured attempt',
  );
  assert.equal(costs.length, attempts.length, 'Cost execution set differs');
  for (const a of attempts) {
    const slot = manifest.slots.find((s) => s.id === a.slot.id);
    const c = costByRun.get(a.runId);
    assert.ok(
      slot && contentIdentity(slot) === contentIdentity(a.slot),
      'Measurement slot differs',
    );
    assert.equal(
      a.experimentIdentity,
      manifest.identity,
      'Measurement experiment differs',
    );
    assert.equal(
      a.modelProfileId,
      manifest.inputs.modelProfile?.id,
      'Measurement profile differs',
    );
    assert.ok(c, 'Missing cost attempt');
    assert.equal(
      c.experimentIdentity,
      a.experimentIdentity,
      'Cost experiment differs',
    );
    assert.equal(c.taskId, slot.taskId, 'Cost task differs');
    assert.equal(c.condition, slot.condition, 'Cost condition differs');
    assert.equal(c.repetition, slot.repetition, 'Cost repetition differs');
    assert.equal(
      c.traceSha256,
      a.evidence.find((entry) => entry.kind === 'trace')?.sha256 ?? null,
      'Cost trace differs',
    );
    assert.equal(c.complete, c.totalUsd !== null, 'Cost completeness differs');
    if (c.complete)
      assert.equal(c.totalUsd, c.observedUsd, 'Complete cost differs');
  }
  const summarize = (cells: Cell[]) => ({
    ...(version === 2 && {
      // Input includes cached tokens. Partial totals remain observed evidence,
      // never a complete execution or a zero-token substitute.
      inputTokens: measurement(
        cells,
        (a) => (a.usage?.complete ? a.usage.inputTokens : null),
        (a) => a.usage?.inputTokens ?? null,
      ),
    }),
    agentMs: measurement(cells, (a) => a.time.agentMs),
    endToEndMs: measurement(cells, (a) => a.time.endToEndMs),
    apiEquivalentUsd: measurement(
      cells,
      (a) => costByRun.get(a.runId)!.totalUsd,
      (a) => costByRun.get(a.runId)!.observedUsd,
    ),
    settledUsd: measurement(cells, (a) => a.usage?.settledUsd ?? null),
  });
  const tasks = manifest.inputs.tasks.map((task) => ({
    id: task.id,
    role:
      task.domain === 'negative-control'
        ? ('negative-control' as const)
        : ('main' as const),
    cells: manifest.inputs.conditions.map(({ id }) => ({
      condition: id,
      attempts: attempts.filter(
        (a) => a.slot.taskId === task.id && a.slot.condition === id,
      ),
    })),
  }));
  const group = (role: 'main' | 'negative-control') => {
    const selected = tasks.filter((t) => t.role === role);
    return {
      all: summarize(selected.flatMap((t) => t.cells)),
      conditions: Object.fromEntries(
        manifest.inputs.conditions.map(({ id }) => [
          id,
          summarize(
            selected.flatMap((t) => t.cells.filter((c) => c.condition === id)),
          ),
        ]),
      ),
    };
  };
  return {
    version,
    policy: 'task-condition-equal-all-executions' as const,
    pricing: {
      identity: pricingIdentity,
      version: pricing.version,
      observedOn: pricing.observedOn,
    },
    main: group('main'),
    negativeControls: group('negative-control'),
    tasks: tasks.map((t) => ({
      id: t.id,
      ...(version === 2 && { all: summarize(t.cells) }),
      conditions: Object.fromEntries(
        t.cells.map((c) => [c.condition, summarize([c])]),
      ),
    })),
    // Private per-execution lineage, never copied into the public projection.
    costs,
  };
}
export type CampaignMeasurements = ReturnType<typeof buildCampaignMeasurements>;
export type AveragedMeasurement =
  CampaignMeasurements['main']['all']['agentMs'];
export type ExecutionMeasurements = CampaignMeasurements['main']['all'];
