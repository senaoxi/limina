import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { canonicalJson, contentIdentity } from './identity.ts';
import {
  assertDigest,
  type ModelProfile,
  verifyModelProfile,
} from './model-profile.ts';

export interface UsageRecord {
  modelEvidence?: {
    observedModelIds: string[];
    modelProfileId: string | null;
    traceDigest: string | null;
  };
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  credits: number | null;
  estimatedUsd: number | null;
  settledUsd: number | null;
  source: string;
  complete: boolean;
  settlement: 'included' | 'pending' | 'settled' | 'unknown';
  financialEvidence?: {
    kind: 'invoice' | 'provider-settlement';
    source: string;
    observedAt: string;
    sha256: string;
  };
}

export interface BillingEvidence {
  mode: 'included_only' | 'credits' | 'usd' | 'unknown';
  observedAt: string;
  source: string;
  ordinaryUsageAllowed: boolean | null;
  autoReloadDisabled: boolean;
  creditBalance: number | null;
  rateCardVersion: string | null;
  /**
  Required before paid dispatch; a forecast is not a hard spending bound.
  */
  providerEnforcedCeilingUsd: number | null;
  settingsObservedAt?: string;
  accountPlan?: string;
  unlimitedCredits?: boolean;
}

interface Reservation {
  runId: string;
  taskId: string;
  model: string;
  reasoningEffort: string;
  speed?: 'standard';
  serviceTier?: 'default';
  modelProfile?: ModelProfile;
  campaignId?: string;
  experimentIdentity?: string;
  slotId?: string;
  maximumUsd: number;
  estimatedUsd: number | null;
  billing: BillingEvidence;
}

interface BudgetAttempt {
  reservation: Reservation;
  usage: UsageRecord | null;
  notDispatchedEvidence: string | null;
}

/**
Legacy inclusion was a dispatch classification, never a dollar receipt.
*/
export function normalizeFinancialUsage(usage: UsageRecord): UsageRecord {
  if (
    usage.settlement === 'included' ||
    (usage.settledUsd !== null && usage.financialEvidence === undefined)
  ) {
    const measurements = {
      ...usage,
      settledUsd: null,
      settlement: 'unknown' as const,
    };
    delete measurements.financialEvidence;
    return measurements;
  }
  return usage;
}

function hasIncludedBound(reservation: Reservation): boolean {
  const billing = reservation.billing;
  return (
    reservation.maximumUsd === 0 &&
    billing.mode === 'included_only' &&
    billing.ordinaryUsageAllowed === true &&
    billing.creditBalance === 0 &&
    billing.autoReloadDisabled &&
    billing.unlimitedCredits !== true &&
    (billing.accountPlan === undefined ||
      ['plus', 'pro', 'prolite', 'promax'].includes(billing.accountPlan))
  );
}

function resolved(attempt: BudgetAttempt, mode: BillingEvidence['mode']) {
  if (attempt.notDispatchedEvidence) return true;
  if (!attempt.usage) return false;
  // Usage is recorded only after finalization. Partial measurements remain
  // unknown, but an admitted zero-paid route can fund further included work.
  // Every new reservation still requires fresh account evidence. Paid work
  // requires complete usage and independent monetary settlement.
  return (
    (mode === 'included_only' && hasIncludedBound(attempt.reservation)) ||
    (attempt.usage.complete && attempt.usage.settlement === 'settled')
  );
}

type Event =
  | { type: 'reserve'; reservation: Reservation }
  | { type: 'not_dispatched'; runId: string; evidenceDigest: string }
  | { type: 'usage'; runId: string; usage: UsageRecord };
interface Entry {
  version: 1;
  previous: string | null;
  event: Event;
  digest: string;
}

function money(value: number): number {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(Math.round(value * 1e6))
  )
    throw new Error('Invalid USD amount');
  return Math.ceil(value * 1e6);
}

function validateUsage(usage: UsageRecord): void {
  if (
    !['included', 'pending', 'settled', 'unknown'].includes(usage.settlement) ||
    typeof usage.complete !== 'boolean' ||
    typeof usage.source !== 'string' ||
    !usage.source
  )
    throw new Error('Invalid usage metadata');
  for (const value of [
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
  ]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0))
      throw new Error('Invalid token count');
  }
  if (
    usage.cachedInputTokens !== null &&
    usage.inputTokens !== null &&
    usage.cachedInputTokens > usage.inputTokens
  )
    throw new Error('Cached tokens exceed input tokens');
  if (usage.estimatedUsd !== null) money(usage.estimatedUsd);
  if (usage.settledUsd !== null) money(usage.settledUsd);
  if (usage.modelEvidence) {
    const evidence = usage.modelEvidence;
    if (
      evidence.observedModelIds.some(
        (id) => !/^[a-z\d][a-z\d.-]{1,79}$/.test(id),
      )
    )
      throw new Error('Invalid observed model identity');
    if (evidence.modelProfileId !== null) assertDigest(evidence.modelProfileId);
    if (evidence.traceDigest !== null) assertDigest(evidence.traceDigest);
  }
  if (
    usage.credits !== null &&
    (!Number.isFinite(usage.credits) || usage.credits < 0)
  )
    throw new Error('Invalid credits');
  if (
    usage.complete &&
    [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens].includes(
      null,
    )
  )
    throw new Error('Complete usage requires token evidence');
  if (usage.settlement === 'included')
    throw new Error('Inclusion is a policy classification, not settlement');
  if (usage.settledUsd !== null) {
    const evidence = usage.financialEvidence;
    if (
      !evidence ||
      usage.settlement !== 'settled' ||
      !['invoice', 'provider-settlement'].includes(evidence.kind) ||
      !evidence.source ||
      !Number.isFinite(Date.parse(evidence.observedAt)) ||
      !/^[a-f\d]{64}$/.test(evidence.sha256)
    )
      throw new Error('Actual USD requires independent settlement evidence');
  }
  if (usage.settlement === 'settled' && usage.settledUsd === null)
    throw new Error('Settlement requires actual USD');
}

/**
Controller-only, fsync-backed ledger. A stale lock or partial write fails closed.
*/
export class BudgetManager {
  static readSnapshot(
    ledger: string,
    bytes: Uint8Array,
  ): ReturnType<BudgetManager['summary']> {
    const reader = new BudgetManager(ledger);
    reader.#snapshot = Buffer.from(bytes).toString('utf8');
    return reader.summary();
  }
  #snapshot: string | undefined;
  readonly totalLimit = 100;
  readonly reserve = 15;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  #read(): Entry[] {
    if (this.#snapshot === undefined && !existsSync(this.path)) return [];
    const raw = this.#snapshot ?? readFileSync(this.path, 'utf8');
    if (raw !== '' && !raw.endsWith('\n'))
      throw new Error('Incomplete budget ledger');
    let previous: string | null = null;
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line) as Entry;
        if (
          entry.version !== 1 ||
          entry.previous !== previous ||
          entry.digest !==
            contentIdentity({ version: 1, previous, event: entry.event })
        )
          throw new Error('Invalid budget ledger chain');
        previous = entry.digest;
        return entry;
      });
  }

  #append(event: Event, entries: Entry[]): void {
    const previous = entries.at(-1)?.digest ?? null;
    const body = { version: 1 as const, previous, event };
    const fd = openSync(this.path, 'a', 0o600);
    try {
      writeSync(
        fd,
        `${canonicalJson({ ...body, digest: contentIdentity(body) })}\n`,
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  #locked(action: (entries: Entry[]) => void): void {
    mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    mkdirSync(lock, { mode: 0o700 });
    try {
      action(this.#read());
    } finally {
      rmSync(lock, { recursive: true });
    }
  }

  #state(entries: Entry[]) {
    const attempts = new Map<string, BudgetAttempt>();
    for (const { event } of entries) {
      if (event.type === 'reserve') {
        if (attempts.has(event.reservation.runId))
          throw new Error('Duplicate budget reservation');
        attempts.set(event.reservation.runId, {
          reservation: event.reservation,
          usage: null,
          notDispatchedEvidence: null,
        });
      } else {
        const attempt = attempts.get(event.runId);
        if (!attempt) throw new Error('Usage without reservation');
        if (event.type === 'not_dispatched')
          attempt.notDispatchedEvidence = event.evidenceDigest;
        else {
          if (
            event.usage.settledUsd !== null &&
            event.usage.settledUsd > 0 &&
            event.usage.financialEvidence === undefined
          )
            throw new Error(
              'Unverified monetary claim requires reconciliation',
            );
          const usage = normalizeFinancialUsage(event.usage);
          validateUsage(usage);
          attempt.usage = usage;
        }
      }
    }
    return attempts;
  }

  reserveAttempt(reservation: Reservation, now = Date.now()): void {
    this.#locked((entries) => {
      if (reservation.modelProfile) {
        verifyModelProfile(reservation.modelProfile);
        for (const d of [
          reservation.campaignId,
          reservation.experimentIdentity,
          reservation.slotId,
        ])
          assertDigest(d);
        if (
          reservation.model !== reservation.modelProfile.canonicalModelId ||
          reservation.reasoningEffort !==
            reservation.modelProfile.reasoningEffort ||
          reservation.serviceTier !==
            reservation.modelProfile.requestedServiceTier ||
          reservation.speed !== undefined ||
          !reservation.runId.startsWith(`${reservation.slotId!}-`)
        )
          throw new Error('Reservation model or slot differs from profile');
      }
      if (
        !reservation.runId ||
        !reservation.taskId ||
        (!reservation.modelProfile &&
          (reservation.model !== 'gpt-6.1-terra' ||
            reservation.reasoningEffort !== 'high' ||
            reservation.speed !== 'standard' ||
            reservation.serviceTier !== undefined ||
            reservation.campaignId !== undefined ||
            reservation.experimentIdentity !== undefined ||
            reservation.slotId !== undefined))
      )
        throw new Error('Invalid attempt identity');
      const state = this.#state(entries);
      if (state.has(reservation.runId))
        throw new Error('Attempt already reserved');
      if (
        state
          .values()
          .some((attempt) => !resolved(attempt, reservation.billing.mode))
      )
        throw new Error('Unsettled or unknown usage prevents dispatch');
      if (
        state
          .values()
          .some(
            ({ usage, reservation: prior }) =>
              (usage?.settledUsd ?? 0) > prior.maximumUsd,
          )
      )
        throw new Error('Observed spend exceeded its enforced ceiling');
      const billing = reservation.billing;
      const age = now - Date.parse(billing.observedAt);
      if (
        !Number.isFinite(age) ||
        age < 0 ||
        age > 60_000 ||
        !billing.source ||
        !billing.autoReloadDisabled
      )
        throw new Error('Fresh billing evidence required');
      if (
        billing.settingsObservedAt !== undefined &&
        (!Number.isFinite(Date.parse(billing.settingsObservedAt)) ||
          Date.parse(billing.settingsObservedAt) > now)
      )
        throw new Error('Invalid settings observation time');
      const maximum = money(reservation.maximumUsd);
      if (billing.mode === 'included_only') {
        if (
          maximum !== 0 ||
          billing.ordinaryUsageAllowed !== true ||
          billing.creditBalance !== 0 ||
          billing.unlimitedCredits !== false ||
          !['plus', 'pro', 'prolite', 'promax'].includes(
            billing.accountPlan ?? '',
          )
        )
          throw new Error('Included-only allowance unavailable');
      } else if (
        billing.mode === 'unknown' ||
        billing.providerEnforcedCeilingUsd === null ||
        !billing.rateCardVersion ||
        money(billing.providerEnforcedCeilingUsd) > maximum
      ) {
        throw new Error('Paid dispatch lacks an enforceable cost bound');
      }
      const exposure = state
        .values()
        .reduce(
          (sum, attempt) =>
            sum +
            (attempt.notDispatchedEvidence
              ? 0
              : money(
                  attempt.usage?.settledUsd ?? attempt.reservation.maximumUsd,
                )),
          0,
        );
      const reserve = Math.max(money(this.reserve), maximum);
      if (exposure + maximum + reserve > money(this.totalLimit))
        throw new Error('Total budget exhausted');
      this.#append({ type: 'reserve', reservation }, entries);
    });
  }

  recordUsage(runId: string, usage: UsageRecord): void {
    validateUsage(usage);
    this.#locked((entries) => {
      const attempt = this.#state(entries).get(runId);
      if (!attempt) throw new Error('Unknown attempt');
      if (attempt.notDispatchedEvidence)
        throw new Error('Dispatch evidence requires explicit reconciliation');
      if (
        attempt.usage &&
        canonicalJson(attempt.usage) === canonicalJson(usage)
      )
        return;
      if (
        attempt.usage?.complete &&
        (!usage.complete ||
          (['inputTokens', 'cachedInputTokens', 'outputTokens'] as const).some(
            (key) => attempt.usage![key] !== usage[key],
          ))
      )
        throw new Error('Complete token evidence is immutable');
      if (
        attempt.usage?.settledUsd !== null &&
        attempt.usage?.settledUsd !== undefined &&
        usage.settledUsd === null
      )
        throw new Error('Known settlement cannot become unknown');
      if (
        attempt.usage?.financialEvidence &&
        attempt.usage.financialEvidence.sha256 ===
          usage.financialEvidence?.sha256 &&
        attempt.usage.settledUsd !== usage.settledUsd
      )
        throw new Error(
          'The same settlement evidence cannot report another amount',
        );
      if (
        attempt.usage?.modelEvidence &&
        contentIdentity(attempt.usage.modelEvidence) !==
          contentIdentity(usage.modelEvidence ?? null)
      )
        throw new Error(
          'Observed model evidence cannot be overwritten by settlement',
        );
      // Preserve unexpected charges as evidence. Subsequent dispatch fails closed.
      this.#append({ type: 'usage', runId, usage }, entries);
    });
  }

  /**
Release only with controller evidence that no inference request was submitted.
Unknown usage stays null in the original record; this is not a zero-token bill.
*/
  recordNotDispatched(runId: string, evidenceDigest: string): void {
    if (!/^[a-f\d]{64}$/.test(evidenceDigest))
      throw new Error('A frozen non-dispatch evidence digest is required');
    this.#locked((entries) => {
      const attempt = this.#state(entries).get(runId);
      if (!attempt || attempt.notDispatchedEvidence)
        throw new Error('Invalid non-dispatch transition');
      if (
        attempt.usage &&
        [
          attempt.usage.inputTokens,
          attempt.usage.cachedInputTokens,
          attempt.usage.outputTokens,
          attempt.usage.settledUsd,
        ].some((value) => value !== null)
      )
        throw new Error('Observed usage contradicts non-dispatch');
      this.#append({ type: 'not_dispatched', runId, evidenceDigest }, entries);
    });
  }

  summary() {
    const attempts = this.#state(this.#read()).values().toArray();
    const dispatched = attempts.filter(
      (attempt) => !attempt.notDispatchedEvidence,
    );
    const observed = dispatched.reduce(
      (sum, { usage }) => sum + money(usage?.settledUsd ?? 0),
      0,
    );
    const financialUnknown = dispatched.filter(
      (attempt) => attempt.usage?.settledUsd === null || !attempt.usage,
    ).length;
    const settled = financialUnknown === 0 ? observed : null;
    const maximumExposure = dispatched.reduce(
      (sum, attempt) =>
        sum +
        money(attempt.usage?.settledUsd ?? attempt.reservation.maximumUsd),
      0,
    );
    const committed = attempts
      .filter(
        ({ usage, notDispatchedEvidence }) =>
          !notDispatchedEvidence && (usage?.settledUsd === null || !usage),
      )
      .reduce((sum, { reservation }) => sum + money(reservation.maximumUsd), 0);
    const estimates = attempts.map(
      ({ usage, reservation }) =>
        usage?.estimatedUsd ?? reservation.estimatedUsd,
    );
    return {
      currency: 'USD',
      totalLimit: this.totalLimit,
      reserve: this.reserve,
      committedSpend: committed / 1e6,
      observedSettledSpend: observed / 1e6,
      settledSpend: settled === null ? null : settled / 1e6,
      financialUnknownRecords: financialUnknown,
      maximumExposure: maximumExposure / 1e6,
      remainingAuthorization: Math.max(
        0,
        (money(this.totalLimit) - maximumExposure) / 1e6,
      ),
      includedDispatchReady: attempts.every((attempt) =>
        resolved(attempt, 'included_only'),
      ),
      estimatedSpend: estimates.includes(null)
        ? null
        : estimates.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      remainingBudget:
        settled === null
          ? null
          : Math.max(0, (money(this.totalLimit) - settled - committed) / 1e6),
      attempts,
    };
  }
}
