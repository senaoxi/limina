import {
  LIMINA_CHECK_TASK_NAMES,
  type LiminaCheckTaskName,
} from '../../src/check-reporting/snapshot';
import {
  FAULT_INJECTION_POINTS,
  type FaultInjection,
  type FaultInjectionDefinition,
  type FaultInjectionPoint,
} from './detector-fixture-types';

const FAULT_POINT_SET = new Set<string>(FAULT_INJECTION_POINTS);
const TASK_NAME_SET = new Set<string>(LIMINA_CHECK_TASK_NAMES);
const SUPPORTED_SIGNALS = new Set<NodeJS.Signals>([
  'SIGINT',
  'SIGKILL',
  'SIGTERM',
]);

const FAULT_KINDS_BY_POINT: Readonly<
  Record<FaultInjectionPoint, ReadonlySet<FaultInjection['kind']>>
> = {
  'cleanup.execute': new Set(['throw']),
  'execution.finalize': new Set(['throw']),
  'filesystem.close': new Set(['throw']),
  'filesystem.fsync': new Set(['throw']),
  'filesystem.read': new Set(['throw']),
  'filesystem.rename': new Set(['throw']),
  'filesystem.write': new Set(['throw']),
  'process.protocol': new Set(['invalid-protocol']),
  'process.spawn': new Set(['throw']),
  'process.stderr': new Set(['stream-error']),
  'process.stdout': new Set(['stream-error']),
  'process.wait': new Set(['process-exit', 'process-signal', 'timeout']),
  'snapshot.install': new Set(['throw']),
  'snapshot.serialize': new Set(['throw']),
  'snapshot.write': new Set(['throw']),
  'task.execute': new Set(['throw']),
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === null || prototype === Object.prototype;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !allowedSet.has(key));

  if (unsupported.length > 0) {
    throw new Error(
      `${label} contains unsupported fields: ${unsupported.sort().join(', ')}.`,
    );
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function optionalCode(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, label);
}

function validateFault(value: unknown, label: string): FaultInjection {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const kind = requireNonEmptyString(value.kind, `${label}.kind`);

  if (kind === 'throw') {
    assertOnlyKeys(value, ['code', 'kind', 'message', 'name'], label);
    return {
      code: optionalCode(value.code, `${label}.code`),
      kind,
      message: requireNonEmptyString(value.message, `${label}.message`),
      name: requireNonEmptyString(value.name, `${label}.name`),
    };
  }
  if (kind === 'process-exit') {
    assertOnlyKeys(value, ['exitCode', 'kind'], label);
    if (
      !Number.isInteger(value.exitCode) ||
      (value.exitCode as number) < 1 ||
      (value.exitCode as number) > 255
    ) {
      throw new Error(
        `${label}.exitCode must be an integer from 1 through 255.`,
      );
    }
    return { exitCode: value.exitCode as number, kind };
  }
  if (kind === 'process-signal') {
    assertOnlyKeys(value, ['kind', 'signal'], label);
    const signal = requireNonEmptyString(value.signal, `${label}.signal`);
    if (!SUPPORTED_SIGNALS.has(signal as NodeJS.Signals)) {
      throw new Error(`${label}.signal is unsupported: ${signal}.`);
    }
    return { kind, signal: signal as NodeJS.Signals };
  }
  if (kind === 'timeout') {
    assertOnlyKeys(value, ['kind'], label);
    return { kind };
  }
  if (kind === 'invalid-protocol') {
    assertOnlyKeys(value, ['kind', 'payload'], label);
    return {
      kind,
      payload: requireNonEmptyString(value.payload, `${label}.payload`),
    };
  }
  if (kind === 'stream-error') {
    assertOnlyKeys(value, ['code', 'kind', 'stream'], label);
    if (value.stream !== 'stdout' && value.stream !== 'stderr') {
      throw new Error(`${label}.stream must be stdout or stderr.`);
    }
    return {
      code: optionalCode(value.code, `${label}.code`),
      kind,
      stream: value.stream,
    };
  }

  throw new Error(`${label}.kind is unsupported: ${kind}.`);
}

export function validateFaultInjectionDefinition(
  value: unknown,
  label: string,
): FaultInjectionDefinition {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, ['fault', 'occurrence', 'point', 'task'], label);
  const pointValue = requireNonEmptyString(value.point, `${label}.point`);
  if (!FAULT_POINT_SET.has(pointValue)) {
    throw new Error(`${label}.point is unsupported: ${pointValue}.`);
  }
  const point = pointValue as FaultInjectionPoint;
  const taskValue = requireNonEmptyString(value.task, `${label}.task`);
  if (!TASK_NAME_SET.has(taskValue)) {
    throw new Error(`${label}.task is unsupported: ${taskValue}.`);
  }
  const fault = validateFault(value.fault, `${label}.fault`);
  if (!FAULT_KINDS_BY_POINT[point].has(fault.kind)) {
    throw new Error(
      `${label}.fault.kind ${fault.kind} is not valid for ${point}.`,
    );
  }
  if (
    fault.kind === 'stream-error' &&
    ((point === 'process.stdout' && fault.stream !== 'stdout') ||
      (point === 'process.stderr' && fault.stream !== 'stderr'))
  ) {
    throw new Error(`${label}.fault.stream does not match ${point}.`);
  }
  if (
    (point === 'process.spawn' ||
      point === 'process.stderr' ||
      point === 'process.stdout' ||
      point === 'process.wait') &&
    taskValue !== 'command'
  ) {
    throw new Error(`${label}.task must be command for ${point}.`);
  }
  if (
    point === 'process.protocol' &&
    taskValue !== 'checker:build' &&
    taskValue !== 'checker:typecheck'
  ) {
    throw new Error(
      `${label}.task must be checker:build or checker:typecheck for process.protocol.`,
    );
  }
  if (point === 'filesystem.read' && taskValue !== 'workspace:validate') {
    throw new Error(
      `${label}.task must be workspace:validate for filesystem.read.`,
    );
  }
  const occurrence = value.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || (occurrence as number) < 1) {
    throw new Error(`${label}.occurrence must be a positive integer.`);
  }

  return {
    fault,
    occurrence: occurrence as number,
    point,
    task: taskValue as LiminaCheckTaskName,
  };
}

export interface FaultConsumptionObservation {
  readonly consumed: boolean;
  readonly expectedOccurrence: number;
  readonly id: 'primary' | 'secondary';
  readonly observedOccurrences: number;
  readonly point: FaultInjectionPoint;
  readonly task: LiminaCheckTaskName;
}

export function assertDistinctFaultInjectionTargets(
  primary: FaultInjectionDefinition,
  secondary: FaultInjectionDefinition | undefined,
  label: string,
): void {
  if (
    secondary &&
    primary.point === secondary.point &&
    primary.task === secondary.task
  ) {
    throw new Error(
      `${label} cannot target ${primary.point} for ${primary.task} twice; use separate fixtures so both faults remain observable.`,
    );
  }
}

interface TrackedFault {
  consumed: boolean;
  definition: FaultInjectionDefinition;
  id: 'primary' | 'secondary';
  observedOccurrences: number;
}

export function createInjectedFaultError(
  fault:
    | Extract<FaultInjection, { kind: 'throw' }>
    | Extract<FaultInjection, { kind: 'stream-error' }>,
): Error {
  const error =
    fault.kind === 'throw'
      ? new Error(fault.message)
      : new Error(`Injected ${fault.stream} stream failure.`);
  error.name = fault.kind === 'throw' ? fault.name : 'FaultInjectedStreamError';
  if (fault.code !== undefined) {
    Object.defineProperty(error, 'code', {
      configurable: true,
      enumerable: true,
      value: fault.code,
    });
  }
  return error;
}

export class FaultInjectionController {
  readonly #tracked: TrackedFault[];

  constructor(
    primary: FaultInjectionDefinition,
    secondary?: FaultInjectionDefinition,
  ) {
    assertDistinctFaultInjectionTargets(
      primary,
      secondary,
      'Fault injection plan',
    );
    this.#tracked = [
      {
        consumed: false,
        definition: primary,
        id: 'primary',
        observedOccurrences: 0,
      },
      ...(secondary
        ? [
            {
              consumed: false,
              definition: secondary,
              id: 'secondary' as const,
              observedOccurrences: 0,
            },
          ]
        : []),
    ];
  }

  observe(
    point: FaultInjectionPoint,
    task: LiminaCheckTaskName,
  ): FaultInjection | undefined {
    let selected: FaultInjection | undefined;

    for (const tracked of this.#tracked) {
      if (
        tracked.definition.point !== point ||
        tracked.definition.task !== task
      ) {
        continue;
      }
      tracked.observedOccurrences += 1;
      if (
        !tracked.consumed &&
        tracked.observedOccurrences === (tracked.definition.occurrence ?? 1)
      ) {
        tracked.consumed = true;
        selected ??= tracked.definition.fault;
      }
    }

    return selected;
  }

  throwIfRequested(
    point: FaultInjectionPoint,
    task: LiminaCheckTaskName,
  ): void {
    const fault = this.observe(point, task);
    if (!fault) return;
    if (fault.kind !== 'throw' && fault.kind !== 'stream-error') {
      throw new Error(
        `Fault ${fault.kind} at ${point} requires a boundary-specific executor.`,
      );
    }
    throw createInjectedFaultError(fault);
  }

  observations(): readonly FaultConsumptionObservation[] {
    return this.#tracked.map((tracked) => ({
      consumed: tracked.consumed,
      expectedOccurrence: tracked.definition.occurrence ?? 1,
      id: tracked.id,
      observedOccurrences: tracked.observedOccurrences,
      point: tracked.definition.point,
      task: tracked.definition.task!,
    }));
  }

  assertConsumed(fixtureId: string): void {
    const unconsumed = this.observations().filter(
      (observation) => !observation.consumed,
    );
    if (unconsumed.length === 0) return;

    throw new Error(
      [
        `Fault fixture ${fixtureId} did not consume every declared fault.`,
        ...unconsumed.map(
          (observation) =>
            `${observation.id}: point=${observation.point} task=${observation.task} expected occurrence=${observation.expectedOccurrence} observed=${observation.observedOccurrences}`,
        ),
      ].join('\n'),
    );
  }
}
