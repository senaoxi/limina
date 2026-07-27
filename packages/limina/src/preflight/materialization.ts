import type { MaterializationReceipt } from './types';

export interface MaterializationSlot {
  generation: number;
  inFlight?: Promise<MaterializationReceipt>;
  receipt?: MaterializationReceipt;
}

interface EnsureMaterializationOptions {
  getCurrentSlot: () => MaterializationSlot;
  materialize: () => Promise<MaterializationReceipt>;
  slot: MaterializationSlot;
}

interface MaterializationCommitContext {
  currentSlot: MaterializationSlot;
  inFlight: Promise<MaterializationReceipt>;
  receipt: MaterializationReceipt;
  slot: MaterializationSlot;
}

function isCurrentCommit(context: MaterializationCommitContext): boolean {
  const checks = [
    context.currentSlot === context.slot,
    context.slot.inFlight === context.inFlight,
    context.slot.generation === context.receipt.generation,
  ];

  return checks.every(Boolean);
}

function commitReceipt(context: MaterializationCommitContext): void {
  if (!isCurrentCommit(context)) {
    return;
  }

  context.slot.receipt = context.receipt;
  context.slot.inFlight = undefined;
}

function clearFailedInFlight(options: {
  currentSlot: MaterializationSlot;
  inFlight: Promise<MaterializationReceipt>;
  slot: MaterializationSlot;
}): void {
  const isCurrent =
    options.currentSlot === options.slot &&
    options.slot.inFlight === options.inFlight;

  if (isCurrent) {
    options.slot.inFlight = undefined;
  }
}

function createMaterializationPromise(
  options: EnsureMaterializationOptions,
): Promise<MaterializationReceipt> {
  return options.materialize();
}

export function ensureMaterialization(
  options: EnsureMaterializationOptions,
): Promise<MaterializationReceipt> {
  if (options.slot.receipt !== undefined) {
    return Promise.resolve(options.slot.receipt);
  }

  if (options.slot.inFlight !== undefined) {
    return options.slot.inFlight;
  }

  const inFlight = createMaterializationPromise(options);
  options.slot.inFlight = inFlight;

  return inFlight.then(
    (receipt) => {
      commitReceipt({
        currentSlot: options.getCurrentSlot(),
        inFlight,
        receipt,
        slot: options.slot,
      });
      return receipt;
    },
    (error: unknown) => {
      clearFailedInFlight({
        currentSlot: options.getCurrentSlot(),
        inFlight,
        slot: options.slot,
      });
      throw error;
    },
  );
}
