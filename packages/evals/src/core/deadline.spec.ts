import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { GradingDeadline, GradingDeadlineExceeded } from './deadline.ts';

test('expired phases cannot start or accept a late successful result', async () => {
  const expired = new GradingDeadline(10);
  await delay(25);
  let isInvoked = false;
  await assert.rejects(
    expired.run(async () => {
      isInvoked = true;
      return 'green';
    }),
    GradingDeadlineExceeded,
  );
  assert.equal(isInvoked, false);
  const active = new GradingDeadline(20);
  await assert.rejects(
    active.run(async () => {
      await delay(60);
      return 'green';
    }),
    GradingDeadlineExceeded,
  );
  assert.equal(active.remaining(), 0);
  assert.throws(() => active.timeout(300_000), GradingDeadlineExceeded);
});

test('grading budgets cannot exceed the frozen maximum and commands share remaining time', async () => {
  assert.throws(() => new GradingDeadline(300_001));
  assert.throws(() => new GradingDeadline(0));
  const deadline = new GradingDeadline(1000);
  const before = deadline.timeout(300_000);
  await delay(25);
  assert.ok(deadline.timeout(300_000) < before);
  assert.equal(deadline.timeout(1), 1);
});
