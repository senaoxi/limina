import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  apiPricingIdentity,
  estimateRequestUsd,
  estimateTraceCost,
  type RequestEstimate,
  resolveApiPricing,
  summarizeCosts,
} from './estimated-cost.ts';
import { captureSnapshot } from './snapshot.ts';

const request: RequestEstimate = {
  id: 'request-a',
  model: 'gpt-6.1-terra',
  tier: 'default',
  input: 1_000_000,
  cachedInput: 800_000,
  cacheWrite: 0,
  output: 100_000,
};
const close = (actual: number | null, expected: number) =>
  assert.ok(
    actual !== null && Math.abs(actual - expected) < 1e-10,
    `${actual} differs from ${expected}`,
  );
test('API estimates charge cache reads once and apply the published full-request context boundary', () => {
  close(
    estimateRequestUsd({
      ...request,
      input: 100_000,
      cachedInput: 80_000,
      output: 10_000,
    }),
    0.074,
  );
  close(
    estimateRequestUsd({
      ...request,
      input: 272_000,
      cachedInput: 200_000,
      output: 1000,
    }),
    0.087,
  );
  close(
    estimateRequestUsd({
      ...request,
      input: 272_001,
      cachedInput: 200_000,
      output: 1000,
    }),
    0.171502,
  );
  for (const change of [
    { model: 'unknown-model' },
    { model: 'toString' },
    { model: 'gpt-6-sol' },
    { tier: 'priority' },
    { cacheWrite: 1 },
    { cachedInput: 1_000_001 },
    { input: -1 },
    { output: NaN },
  ])
    assert.equal(estimateRequestUsd({ ...request, ...change }), null);
});

test('Sol uses its own reviewed standard rates and preserves the frozen Terra-only snapshot', () => {
  const sol = { ...request, model: 'gpt-6.1-sol' };
  for (const [input, cachedInput, output, expected] of [
    [100_000, 80_000, 10_000, 0.148],
    [272_000, 200_000, 1000, 0.174],
    [272_001, 200_000, 1000, 0.343004],
    [100_000, 100_000, 0, 0.01],
    [0, 0, 0, 0],
  ])
    close(
      estimateRequestUsd({
        ...sol,
        input: input!,
        cachedInput: cachedInput!,
        output: output!,
      }),
      expected!,
    );
  for (const change of [
    { tier: 'priority' },
    { cacheWrite: 1 },
    { input: null },
  ])
    assert.equal(
      estimateRequestUsd({ ...sol, ...change } as RequestEstimate),
      null,
    );
  const historical =
    '2cd329737e95f450ecd7b12a44c39f2ea895c143b0a249c9a3e6d2c014412d85';
  assert.equal(
    resolveApiPricing(historical).version,
    'openai-standard-2026-11-06',
  );
  assert.notEqual(apiPricingIdentity, historical);
  assert.equal(estimateRequestUsd(sol, historical), null);
  close(estimateRequestUsd(request, historical), 1.23);
  assert.throws(
    () => resolveApiPricing('unreviewed'),
    /Unsupported pricing identity/,
  );
});

async function capture(
  options: {
    duplicate?: boolean;
    failed?: boolean;
    tier?: string;
    model?: string;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'eval-cost-'));
  try {
    await mkdir(path.join(root, 'session', 'payloads'), { recursive: true });
    await writeFile(
      path.join(root, 'session', 'manifest.json'),
      JSON.stringify({
        schema_version: 2,
        root_thread_id: 'thread-a',
        rollout_id: 'thread-a',
      }),
    );
    const events: Record<string, unknown>[] = [];
    for (let index = 0; index < 2; index++) {
      const model = options.model ?? 'gpt-6.1-terra';
      await writeFile(
        path.join(root, 'session', 'payloads', `${index * 2}.json`),
        JSON.stringify({ model, service_tier: options.tier }),
      );
      await writeFile(
        path.join(root, 'session', 'payloads', `${index * 2 + 1}.json`),
        JSON.stringify({
          token_usage: {
            input_tokens: 150_000,
            cached_input_tokens: 100_000,
            output_tokens: 1000,
            reasoning_output_tokens: 500,
            cache_write_input_tokens: 0,
          },
        }),
      );
      events.push(
        {
          type: 'inference_started',
          inference_call_id: `call-${index}`,
          model,
          provider_name: 'OpenAI',
          request_payload: { path: `payloads/${index * 2}.json` },
        },
        {
          type: 'inference_completed',
          inference_call_id: `call-${index}`,
          upstream_request_id: `response-${index}`,
          response_payload: { path: `payloads/${index * 2 + 1}.json` },
        },
      );
    }
    if (options.duplicate) events.push(events[1]!);
    if (options.failed)
      events.push(
        {
          type: 'inference_started',
          inference_call_id: 'failed-call',
          model: 'gpt-6.1-terra',
          provider_name: 'OpenAI',
          request_payload: { path: 'payloads/0.json' },
        },
        { type: 'inference_failed', inference_call_id: 'failed-call' },
      );
    events.push({ type: 'rollout_ended' });
    await writeFile(
      path.join(root, 'session', 'trace.jsonl'),
      `${events
        .map((payload, index) =>
          JSON.stringify({
            schema_version: 2,
            seq: index + 1,
            rollout_id: 'thread-a',
            thread_id: 'thread-a',
            payload,
          }),
        )
        .join('\n')}\n`,
    );
    return {
      files: await captureSnapshot(root, 'S1'),
      evidence: {
        threadId: 'thread-a',
        status: 'complete',
        tokensComplete: !options.failed,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const usage = {
  inputTokens: 300_000,
  cachedInputTokens: 200_000,
  outputTokens: 2000,
  complete: true,
};
test('native session accounting prices each request and keeps reasoning inside output tokens', async () => {
  const result = estimateTraceCost(await capture(), usage);
  close(result.totalUsd, 0.12);
  assert.equal(result.pricedRequests, 2);
  assert.equal(result.complete, true);
  assert.notEqual(
    result.totalUsd,
    estimateRequestUsd({
      ...request,
      input: 300_000,
      cachedInput: 200_000,
      output: 2000,
    }),
  );
  const sol = await capture({ model: 'gpt-6.1-sol' });
  close(estimateTraceCost(sol, usage).totalUsd, 0.24);
  assert.equal(
    estimateTraceCost(sol, { ...usage, complete: false }).totalUsd,
    null,
  );
  assert.equal(estimateTraceCost(sol, null).totalUsd, null);
  assert.equal(
    estimateTraceCost(sol, { ...usage, outputTokens: usage.outputTokens + 1 })
      .totalUsd,
    null,
  );
});
test('replayed events, altered evidence, unknown prices and failed inference cannot become complete or free usage', async () => {
  const duplicate = estimateTraceCost(
    await capture({ duplicate: true }),
    usage,
  );
  assert.equal(duplicate.totalUsd, null);
  const altered = await capture();
  altered.files.entries.find((entry) => entry.kind === 'file')!.mode ^= 1;
  assert.equal(estimateTraceCost(altered, usage).totalUsd, null);
  const unknown = estimateTraceCost(
    await capture({ model: 'unknown-model' }),
    usage,
  );
  assert.equal(unknown.pricedRequests, 0);
  assert.equal(unknown.unpricedRequests, 2);
  assert.equal(unknown.totalUsd, null);
  const failed = estimateTraceCost(await capture({ failed: true }), usage);
  close(failed.observedUsd, 0.12);
  assert.equal(failed.unpricedRequests, 1);
  assert.equal(failed.totalUsd, null);
  const aggregate = summarizeCosts([
    estimateTraceCost(await capture(), usage),
    failed,
  ]);
  close(aggregate.observedUsd, 0.24);
  assert.equal(aggregate.totalUsd, null);
  assert.equal(aggregate.completeAttempts, 1);
});
