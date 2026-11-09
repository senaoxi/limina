import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectNativeTrace } from '../runner/native-trace.ts';
import { usageFromEvents } from '../runner/usage.ts';
import type { UsageRecord } from './budget.ts';
import { createModelProfile } from './model-profile.ts';

test('complete CLI token measurements do not establish a monetary settlement', () => {
  const event = {
    type: 'turn.completed',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 70,
      cache_write_input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: 9,
    },
  };
  const usage = usageFromEvents([event]);
  assert.equal(usage.complete, true);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.cachedInputTokens, 70);
  assert.equal(usage.outputTokens, 10);
  assert.equal(usage.settledUsd, null);
  assert.equal(usage.credits, null);
  assert.equal(usage.estimatedUsd, null);
  assert.equal(usage.settlement, 'unknown');
  assert.equal(usageFromEvents([event, event]).complete, false);
});

const reference = (id: number) => ({
  raw_payload_id: `raw_payload:${id}`,
  path: `payloads/${id}.json`,
});

test('new isolated trace policy rejects host AGENTS while legacy trace replay remains readable', async (t) => {
  const fixture = await traceFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const file = path.join(fixture.root, 'trace-one/payloads/2.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(
    file,
    JSON.stringify({
      ...original,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Assess the fixture.' }],
        },
      ],
    }),
  );
  const valid = await collectNativeTrace(
    fixture.root,
    fixture.thread,
    fixture.usage,
    undefined,
    { forbidAgentInstructions: true },
  );
  assert.equal(valid.evidence.status, 'complete');
  for (const heading of [
    '# AGENTS.md instructions for /synthetic/host',
    '# AGENTS.md instructions',
  ]) {
    await writeFile(
      file,
      JSON.stringify({
        ...original,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `${heading}\n<INSTRUCTIONS>HOST_CANARY</INSTRUCTIONS>`,
              },
            ],
          },
        ],
      }),
    );
    const rejected = await collectNativeTrace(
      fixture.root,
      fixture.thread,
      fixture.usage,
      undefined,
      { forbidAgentInstructions: true },
    );
    assert.ok(
      rejected.evidence.errors.includes('TRACE_UNEXPECTED_AGENT_INSTRUCTIONS'),
    );
    const legacy = await collectNativeTrace(
      fixture.root,
      fixture.thread,
      fixture.usage,
    );
    assert.equal(legacy.evidence.status, 'complete');
  }
});

// Synthetic schema-2 wire fixture: no SDK behavior or model output is mocked.
// Actual native tool dispatch and usage evidence is checked by the local repro.
async function traceFixture(model = 'gpt-6.1-terra', effort = 'high') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-native-trace-'));
  const root = await realpath(temporary);
  const bundle = path.join(root, 'trace-one');
  await mkdir(bundle);
  await mkdir(path.join(bundle, 'payloads'));
  const thread = 'synthetic-thread';
  await writeFile(
    path.join(bundle, 'manifest.json'),
    JSON.stringify({
      schema_version: 2,
      root_thread_id: thread,
      rollout_id: thread,
      raw_event_log: 'trace.jsonl',
      payloads_dir: 'payloads',
    }),
  );
  const payloads = [
    {
      session_id: thread,
      model,
      model_provider_id: 'openai',
      approval_policy: 'never',
      reasoning_effort: effort,
      active_permission_profile: { id: 'limina-eval' },
      permission_profile: {
        type: 'managed',
        network: 'restricted',
        file_system: { type: 'restricted' },
      },
    },
    { model, reasoning: { effort } },
    {
      token_usage: {
        input_tokens: 100,
        cached_input_tokens: 40,
        output_tokens: 10,
      },
    },
    {
      type: 'code_mode_response',
      value: { exit_code: 1, output: 'Operation not permitted' },
    },
  ];
  for (const [index, payload] of payloads.entries())
    await writeFile(
      path.join(bundle, 'payloads', `${index + 1}.json`),
      JSON.stringify(payload),
    );
  const events = [
    { type: 'thread_started', thread_id: thread, agent_path: '/root' },
    {
      type: 'protocol_event_observed',
      event_type: 'session_configured',
      event_payload: reference(1),
    },
    {
      type: 'inference_started',
      inference_call_id: 'inference-1',
      model,
      provider_name: 'OpenAI',
      request_payload: reference(2),
    },
    {
      type: 'tool_call_started',
      tool_call_id: 'tool-1',
      kind: { type: 'exec_command' },
    },
    {
      type: 'tool_call_ended',
      tool_call_id: 'tool-1',
      result_payload: reference(4),
    },
    {
      type: 'inference_completed',
      inference_call_id: 'inference-1',
      response_payload: reference(3),
    },
    { type: 'rollout_ended', status: 'completed' },
  ];
  const rows = events.map((payload, index) => ({
    schema_version: 2,
    seq: index + 1,
    rollout_id: thread,
    thread_id: thread,
    payload,
  }));
  await writeFile(
    path.join(bundle, 'trace.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  const usage: UsageRecord = {
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 10,
    credits: null,
    estimatedUsd: null,
    settledUsd: 0,
    complete: true,
    source: 'synthetic-test',
    settlement: 'included',
  };
  return { root, bundle, thread, usage };
}

test('native configuration uses the selected model profile and independently checks sandbox permissions', async (t) => {
  const profile = createModelProfile({
    canonicalModelId: 'synthetic-model',
    displayName: 'Synthetic model',
    providerId: 'openai',
    reasoningEffort: 'medium',
    requestedServiceTier: 'default',
    supportedEfforts: ['medium'],
    capabilitiesDigest: 'a'.repeat(64),
    instructionDigest: 'b'.repeat(64),
    execution: {
      contextWindow: 272_000,
      autoCompactTokenLimit: 244_800,
      toolOutputLimit: 10_000,
    },
    codex: {
      version: '0.166.0',
      sha256: 'c'.repeat(64),
      codeModeHostSha256: 'd'.repeat(64),
    },
  });
  const f = await traceFixture(
    profile.canonicalModelId,
    profile.reasoningEffort,
  );
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const collect = () => collectNativeTrace(f.root, f.thread, f.usage, profile);
  const initial = await collect();
  assert.equal(initial.evidence.status, 'complete');
  const file = path.join(f.bundle, 'payloads', '1.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  for (const changed of [
    { ...original, model: 'gpt-6.1-terra' },
    { ...original, reasoning_effort: 'high' },
    {
      ...original,
      permission_profile: {
        ...original.permission_profile,
        network: 'enabled',
      },
    },
  ]) {
    await writeFile(file, JSON.stringify(changed));
    const rejected = await collect();
    assert.deepEqual(rejected.evidence.errors, [
      'TRACE_EXECUTION_CONFIGURATION',
    ]);
    await writeFile(file, JSON.stringify(original));
    const restored = await collect();
    assert.equal(restored.evidence.status, 'complete');
  }
});

test('native evidence rejects missing tool payloads, session substitution and duplicated cumulative usage', async (t) => {
  const f = await traceFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const baseline = await collectNativeTrace(f.root, f.thread, f.usage);
  assert.equal(baseline.evidence.status, 'complete');
  const file = path.join(f.bundle, 'payloads', '4.json');
  const original = await readFile(file);
  await rm(file);
  const missing = await collectNativeTrace(f.root, f.thread, f.usage);
  assert.deepEqual(missing.evidence.errors, ['TRACE_PAYLOAD_MISSING']);
  await writeFile(file, original);
  const changed = await collectNativeTrace(f.root, 'other-thread', f.usage);
  assert.deepEqual(changed.evidence.errors, ['TRACE_SESSION_CHANGED']);
  const duplicated = await collectNativeTrace(f.root, f.thread, {
    ...f.usage,
    inputTokens: 200,
  });
  assert.deepEqual(duplicated.evidence.errors, ['TRACE_USAGE_MISMATCH']);
  const result = await collectNativeTrace(f.root, f.thread, f.usage);
  assert.equal(result.evidence.status, 'complete');
  assert.equal(result.evidence.inferenceCalls, 1);
  assert.equal(result.evidence.toolCalls, 1);
});

test('a recorded failed inference closes the trace without claiming complete token coverage', async (t) => {
  const f = await traceFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.bundle, 'trace.jsonl');
  const raw = await readFile(file, 'utf8');
  const original = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const failedStart = {
    type: 'inference_started',
    inference_call_id: 'transport-failure',
    model: 'gpt-6.1-terra',
    provider_name: 'OpenAI',
    request_payload: reference(2),
  };
  const failedEnd = {
    type: 'inference_failed',
    inference_call_id: 'transport-failure',
    error: 'synthetic transport closed before completion',
  };
  const write = async (events: unknown[]) => {
    const rows = events.map((payload, index) => ({
      ...original[0],
      seq: index + 1,
      payload,
    }));
    await writeFile(
      file,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
  };
  const events = original.map((row) => row.payload);
  const closed = [
    ...events.slice(0, 2),
    failedStart,
    failedEnd,
    ...events.slice(2),
  ];
  await write(closed);
  const captured = await collectNativeTrace(f.root, f.thread, f.usage);
  assert.equal(captured.evidence.status, 'complete');
  assert.equal(captured.evidence.tokensComplete, false);
  assert.equal(captured.evidence.failedInferenceCalls, 1);
  assert.equal(captured.evidence.inferenceCalls, 2);
  assert.deepEqual(captured.evidence.tokens, {
    input: 100,
    cachedInput: 40,
    output: 10,
  });
  await write(closed.filter((event) => event !== failedEnd));
  const missing = await collectNativeTrace(f.root, f.thread, f.usage);
  assert.deepEqual(missing.evidence.errors, ['TRACE_LIFECYCLE_INCOMPLETE']);
  await write([...closed.slice(0, -1), failedEnd, closed.at(-1)]);
  const duplicate = await collectNativeTrace(f.root, f.thread, f.usage);
  assert.deepEqual(duplicate.evidence.errors, ['TRACE_INFERENCE_PAIR']);
});

test('request model and reasoning cannot contradict an otherwise complete native rollout', async (t) => {
  const f = await traceFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const target = path.join(f.bundle, 'payloads', '2.json');
  for (const [request, expected] of [
    [{ model: 'another-model', reasoning: { effort: 'high' } }, 'partial'],
    [{ model: 'gpt-6.1-terra', reasoning: { effort: 'low' } }, 'partial'],
    [
      {
        model: 'gpt-6.1-terra',
        reasoning: { effort: 'high' },
        service_tier: 'priority',
      },
      'partial',
    ],
    [{ model: 'gpt-6.1-terra', reasoning: { effort: 'high' } }, 'complete'],
  ] as const) {
    await writeFile(target, JSON.stringify(request));
    const captured = await collectNativeTrace(f.root, f.thread, f.usage);
    assert.equal(captured.evidence.status, expected);
  }
});

test('provider response identity is checked when supplied, without inventing missing receipts', async (t) => {
  const f = await traceFixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.bundle, 'payloads', '3.json');
  const original = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(
    file,
    JSON.stringify({ ...original, model: 'another-model' }),
  );
  const wrong = await collectNativeTrace(f.root, f.thread, f.usage);
  assert.deepEqual(wrong.evidence.errors, ['TRACE_RESPONSE_MODEL_CHANGED']);
  assert.ok(wrong.evidence.observedModelIds?.includes('another-model'));
  await writeFile(
    file,
    JSON.stringify({ ...original, model: 'gpt-6.1-terra' }),
  );
  const restored = await collectNativeTrace(f.root, f.thread, f.usage);
  assert.equal(restored.evidence.status, 'complete');
});
