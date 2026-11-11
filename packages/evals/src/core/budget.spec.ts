import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  type BillingEvidence,
  BudgetManager,
  type UsageRecord,
} from './budget.ts';
import { canonicalJson, contentIdentity } from './identity.ts';

const billing: BillingEvidence = {
  mode: 'included_only',
  observedAt: new Date().toISOString(),
  source: 'synthetic-account-observation',
  ordinaryUsageAllowed: true,
  autoReloadDisabled: true,
  creditBalance: 0,
  rateCardVersion: null,
  providerEnforcedCeilingUsd: null,
  accountPlan: 'pro',
  unlimitedCredits: false,
};
const usage: UsageRecord = {
  inputTokens: 100,
  cachedInputTokens: 20,
  outputTokens: 30,
  credits: null,
  estimatedUsd: null,
  settledUsd: null,
  source: 'synthetic-final-usage',
  complete: true,
  settlement: 'unknown',
};
const reservation = (runId: string) => ({
  runId,
  taskId: 'I01',
  model: 'gpt-6.1-terra' as const,
  reasoningEffort: 'high' as const,
  speed: 'standard' as const,
  maximumUsd: 0,
  estimatedUsd: null,
  billing: { ...billing, observedAt: new Date().toISOString() },
});

test('reads completed Team zero-paid evidence without inventing a balance, settlement or new dispatch admission', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-team-budget-'));
  try {
    const file = path.join(root, 'ledger.jsonl');
    const account = 'a'.repeat(64);
    const team = {
      ...billing,
      accountPlan: 'team',
      creditBalance: null,
      nativeHasCredits: false,
      accountIdentitySha256: account,
      teamIncludedEvidence: {
        version: 1 as const,
        source: 'operator-confirmed-payment-controls' as const,
        accountIdentitySha256: account,
        recordedAt: billing.observedAt,
        paidOverageDisabled: true,
        automaticCreditPurchaseDisabled: true,
        maximumExtraUsd: 0,
      },
    };
    const cases = [
      { name: 'bound', value: team, ready: true },
      {
        name: 'missing',
        value: { ...team, teamIncludedEvidence: null },
        ready: false,
      },
      {
        name: 'paid overage',
        value: {
          ...team,
          teamIncludedEvidence: {
            ...team.teamIncludedEvidence,
            paidOverageDisabled: false,
          },
        },
        ready: false,
      },
      {
        name: 'automatic purchase',
        value: {
          ...team,
          teamIncludedEvidence: {
            ...team.teamIncludedEvidence,
            automaticCreditPurchaseDisabled: false,
          },
        },
        ready: false,
      },
      {
        name: 'foreign account',
        value: { ...team, accountIdentitySha256: 'b'.repeat(64) },
        ready: false,
      },
      {
        name: 'credits available',
        value: { ...team, nativeHasCredits: true },
        ready: false,
      },
    ];
    for (const { name, value, ready } of cases) {
      const events = [
        {
          type: 'reserve',
          reservation: { ...reservation('team'), billing: value },
        },
        { type: 'usage', runId: 'team', usage },
      ];
      let previous: string | null = null;
      const bytes = events
        .map((event) => {
          const body = { version: 1, previous, event };
          previous = contentIdentity(body);
          return `${canonicalJson({ ...body, digest: previous })}\n`;
        })
        .join('');
      writeFileSync(file, bytes);
      const result = new BudgetManager(file).summary();
      assert.equal(result.includedDispatchReady, ready, name);
      assert.equal(result.attempts[0]!.reservation.billing.creditBalance, null);
      assert.equal(result.settledSpend, null);
      assert.equal(result.remainingBudget, null);
      assert.equal(result.maximumExposure, 0);
      assert.equal(readFileSync(file, 'utf8'), bytes);
    }
    // Reading the historical evidence never admits a new Team reservation.
    assert.throws(
      () =>
        new BudgetManager(path.join(root, 'fresh.jsonl')).reserveAttempt({
          ...reservation('new-team'),
          billing: { ...team, observedAt: new Date().toISOString() },
        }),
      /Included-only allowance unavailable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('budget survives restart, forbids concurrent dispatch and does not double-count replayed usage', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-budget-'));
  try {
    const ledgerPath = path.join(root, 'ledger.jsonl');
    const manager = new BudgetManager(ledgerPath);
    assert.equal(manager.totalLimit, 100);
    manager.reserveAttempt(reservation('a'));
    assert.throws(
      () => new BudgetManager(ledgerPath).reserveAttempt(reservation('b')),
      /Unsettled/,
    );
    manager.recordUsage('a', usage);
    manager.recordUsage('a', usage);
    assert.throws(
      () => manager.recordNotDispatched('a', 'a'.repeat(64)),
      /contradicts/,
    );
    assert.equal(new BudgetManager(ledgerPath).summary().attempts.length, 1);
    assert.equal(manager.summary().settledSpend, null);
    assert.equal(manager.summary().observedSettledSpend, 0);
    assert.equal(manager.summary().financialUnknownRecords, 1);
    assert.equal(manager.summary().remainingBudget, null);
    assert.equal(manager.summary().remainingAuthorization, 100);
    assert.equal(manager.summary().estimatedSpend, null);
    assert.throws(() => manager.reserveAttempt(reservation('a')), /already/);
    new BudgetManager(ledgerPath).reserveAttempt(reservation('b'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('partial usage permits only a fresh included-only zero-paid reservation after finalization', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-partial-budget-'));
  try {
    const ledger = path.join(root, 'ledger.jsonl');
    const manager = new BudgetManager(ledger);
    manager.reserveAttempt(reservation('partial'));
    assert.throws(
      () => manager.reserveAttempt(reservation('concurrent')),
      /Unsettled/,
    );
    manager.recordUsage('partial', { ...usage, complete: false });
    assert.equal(manager.summary().settledSpend, null);
    assert.equal(manager.summary().remainingBudget, null);
    assert.throws(
      () =>
        manager.reserveAttempt({
          ...reservation('paid'),
          maximumUsd: 1,
          billing: {
            ...billing,
            observedAt: new Date().toISOString(),
            mode: 'usd',
            rateCardVersion: 'synthetic contract',
            providerEnforcedCeilingUsd: 1,
          },
        }),
      /unknown usage/,
    );
    new BudgetManager(ledger).reserveAttempt(reservation('included'));
    const partial = manager.summary().attempts[0]?.usage;
    assert.equal(partial?.complete, false);
    assert.equal(partial?.inputTokens, 100);
    assert.equal(partial?.settledUsd, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('budget rejects missing quota, stale billing and paid use of unknown usage; partial ledger cannot authorize dispatch', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-budget-'));
  try {
    const ledgerPath = path.join(root, 'ledger.jsonl');
    const manager = new BudgetManager(ledgerPath);
    const missing = reservation('missing');
    missing.billing.ordinaryUsageAllowed = null;
    assert.throws(() => manager.reserveAttempt(missing), /unavailable/);
    const stale = reservation('stale');
    stale.billing.observedAt = new Date(0).toISOString();
    assert.throws(() => manager.reserveAttempt(stale), /Fresh/);
    manager.reserveAttempt(reservation('a'));
    manager.recordUsage('a', {
      ...usage,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      complete: false,
      settlement: 'unknown',
      settledUsd: null,
    });
    assert.throws(
      () =>
        manager.reserveAttempt({
          ...reservation('paid'),
          billing: { ...billing, mode: 'unknown' },
        }),
      /unknown/,
    );
    assert.equal(manager.summary().attempts[0]?.usage?.inputTokens, null);
    assert.throws(() => manager.recordNotDispatched('a', ''), /evidence/);
    manager.recordNotDispatched('a', 'b'.repeat(64));
    assert.equal(manager.summary().attempts[0]?.usage?.inputTokens, null);
    manager.reserveAttempt(reservation('b'));
    appendFileSync(ledgerPath, '{');
    assert.throws(
      () => new BudgetManager(ledgerPath).reserveAttempt(reservation('c')),
      /Incomplete/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('one global cap covers retries and protects the reserve; forecasts cannot authorize paid work', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-budget-'));
  try {
    const manager = new BudgetManager(path.join(root, 'ledger.jsonl'));
    const paid = {
      ...reservation('a'),
      maximumUsd: 40,
      billing: {
        ...billing,
        observedAt: new Date().toISOString(),
        mode: 'usd' as const,
        rateCardVersion: 'synthetic-contract',
        providerEnforcedCeilingUsd: null as number | null,
      },
    };
    assert.throws(() => manager.reserveAttempt(paid), /enforceable/);
    paid.billing.providerEnforcedCeilingUsd = 40;
    manager.reserveAttempt(paid);
    manager.recordUsage('a', {
      ...usage,
      settledUsd: 40,
      settlement: 'settled',
      financialEvidence: {
        kind: 'invoice',
        source: 'synthetic offline invoice',
        observedAt: new Date().toISOString(),
        sha256: 'c'.repeat(64),
      },
    });
    assert.throws(
      () => manager.reserveAttempt({ ...paid, runId: 'retry' }),
      /exhausted/,
    );
    assert.equal(manager.summary().settledSpend, 40);
    assert.equal(manager.summary().remainingBudget, 60);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy zero classifications remain unknown and accept append-only monetary reconciliation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eval-budget-'));
  try {
    const file = path.join(root, 'ledger.jsonl');
    const events = [
      { type: 'reserve', reservation: reservation('legacy') },
      {
        type: 'usage',
        runId: 'legacy',
        usage: {
          ...usage,
          settledUsd: 0,
          settlement: 'included',
          source: 'codex-exec:turn.completed',
        },
      },
    ];
    let previous: string | null = null;
    const original = events
      .map((event) => {
        const body = { version: 1, previous, event };
        const entry = { ...body, digest: contentIdentity(body) };
        previous = entry.digest;
        return `${canonicalJson(entry)}\n`;
      })
      .join('');
    writeFileSync(file, original);
    const manager = new BudgetManager(file);
    assert.equal(manager.summary().settledSpend, null);
    assert.equal(manager.summary().financialUnknownRecords, 1);
    assert.equal(manager.summary().attempts[0]!.usage!.settledUsd, null);
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.throws(
      () =>
        manager.recordUsage('legacy', {
          ...usage,
          settledUsd: 0,
          settlement: 'settled',
        }),
      /independent settlement/,
    );
    const actual: UsageRecord = {
      ...usage,
      settledUsd: 1,
      settlement: 'settled',
      financialEvidence: {
        kind: 'invoice',
        source: 'synthetic later invoice',
        observedAt: new Date().toISOString(),
        sha256: 'd'.repeat(64),
      },
    };
    manager.recordUsage('legacy', actual);
    assert.equal(new BudgetManager(file).summary().settledSpend, 1);
    assert.equal(
      readFileSync(file, 'utf8').slice(0, original.length),
      original,
    );
    assert.throws(
      () => manager.recordUsage('legacy', { ...actual, inputTokens: 101 }),
      /token evidence/,
    );
    assert.throws(
      () => manager.recordUsage('legacy', { ...actual, settledUsd: 2 }),
      /same settlement evidence/,
    );
    assert.throws(
      () => manager.reserveAttempt(reservation('next')),
      /exceeded/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
