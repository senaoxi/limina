import { contentIdentity } from './identity.ts';
import { type Snapshot, verifySnapshot } from './snapshot.ts';

/**
Frozen public API prices, never ChatGPT subscription charges or budget authority.
*/
const historicalApiPricing = {
  version: 'openai-standard-2026-11-06',
  currency: 'USD',
  observedOn: '2026-11-06',
  source: 'https://developers.openai.com/api/docs/models/gpt-6.1-terra',
  algorithmSource:
    'https://github.com/steipete/CodexBar/blob/20ada8abf0e4e2267aaa8c7cc9cf891cdf866838/Sources/CodexBarCore/Vendored/CostUsage/CostUsagePricing.swift',
  models: {
    'gpt-6.1-terra': {
      input: 1,
      cachedInput: 0.05,
      output: 5,
      longContextThreshold: 272_000,
      longInputMultiplier: 2,
      longOutputMultiplier: 1.5,
    },
  },
} as const;
export const apiPricing = {
  ...historicalApiPricing,
  version: 'openai-standard-2026-11-09',
  observedOn: '2026-11-09',
  source: 'https://developers.openai.com/api/docs/pricing',
  models: {
    ...historicalApiPricing.models,
    'gpt-6.1-sol': {
      input: 2,
      cachedInput: 0.1,
      output: 10,
      longContextThreshold: 272_000,
      longInputMultiplier: 2,
      longOutputMultiplier: 1.5,
    },
  },
  modelSources: {
    'gpt-6.1-sol': 'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
  },
} as const;
export const apiPricingIdentity = contentIdentity(apiPricing);

/**
Only reviewed, frozen price snapshots may reproduce historical reports.
*/
export function resolveApiPricing(identity: string) {
  const pricing = [historicalApiPricing, apiPricing].find(
    (snapshot) => contentIdentity(snapshot) === identity,
  );
  if (!pricing) throw new Error('Unsupported pricing identity');
  return pricing;
}

interface ModelPrices {
  input: number;
  cachedInput: number;
  output: number;
  longContextThreshold: number;
  longInputMultiplier: number;
  longOutputMultiplier: number;
}

interface RequestTokens {
  input: number;
  cachedInput: number;
  output: number;
  cacheWrite: number;
}
export interface RequestEstimate extends RequestTokens {
  id: string;
  model: string;
  tier: string;
}
export function estimateRequestUsd(
  request: RequestEstimate,
  pricingIdentity = apiPricingIdentity,
): number | null {
  const models: Readonly<Record<string, ModelPrices>> =
    resolveApiPricing(pricingIdentity).models;
  const rate = Object.hasOwn(models, request.model)
    ? models[request.model]
    : undefined;
  if (
    !rate ||
    Object.values({
      input: request.input,
      cachedInput: request.cachedInput,
      output: request.output,
      cacheWrite: request.cacheWrite,
    }).some((value) => !(Number.isSafeInteger(value) && value >= 0)) ||
    request.cachedInput > request.input ||
    request.cacheWrite !== 0 ||
    request.tier !== 'default'
  )
    return null;
  // CodexBar's inclusive-input convention: cached reads are a subset of input.
  // Cache retention is not observable in this trace schema. Nonzero writes stay unpriced.
  const isLong = request.input > rate.longContextThreshold;
  return (
    ((request.input - request.cachedInput) *
      rate.input *
      (isLong ? rate.longInputMultiplier : 1) +
      request.cachedInput *
        rate.cachedInput *
        (isLong ? rate.longInputMultiplier : 1) +
      request.output * rate.output * (isLong ? rate.longOutputMultiplier : 1)) /
    1_000_000
  );
}

export interface CostMeasurement {
  observedUsd: number;
  totalUsd: number | null;
  attempts: number;
  completeAttempts: number;
  pricedRequests: number;
  unpricedRequests: number;
}
export interface TraceCost {
  observedUsd: number;
  totalUsd: number | null;
  pricedRequests: number;
  unpricedRequests: number;
  complete: boolean;
  reason: string | null;
}
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid cost trace object');
  return value as JsonObject;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw new Error('Missing cost trace identity');
  return value;
}

interface CostCapture {
  files: Snapshot;
  evidence: {
    threadId: string | null;
    status: string;
    tokensComplete: boolean;
  };
}
function readCostCapture(capture: CostCapture) {
  verifySnapshot(capture.files);
  const files = new Map(
    capture.files.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => [entry.path, entry.content]),
  );
  const manifests = files
    .keys()
    .filter((p) => /^[^/]+\/manifest\.json$/.test(p))
    .toArray();
  if (manifests.length !== 1) throw new Error('Ambiguous cost trace');
  const prefix = manifests[0]!.slice(0, -'manifest.json'.length);
  const read = (relative: string) => {
    if (!/^(?:manifest\.json|trace\.jsonl|payloads\/\d+\.json)$/.test(relative))
      throw new Error('Invalid cost payload path');
    const bytes = files.get(prefix + relative);
    if (bytes === undefined) throw new Error('Missing cost payload');
    return Buffer.from(bytes, 'base64').toString('utf8');
  };
  const manifest = object(JSON.parse(read('manifest.json')));
  const thread = text(capture.evidence.threadId);
  if (
    manifest.schema_version !== 2 ||
    manifest.root_thread_id !== thread ||
    manifest.rollout_id !== thread
  )
    throw new Error('Cost trace session mismatch');
  const raw = read('trace.jsonl');
  if (!raw.endsWith('\n')) throw new Error('Truncated cost trace');
  const payload = (value: unknown) => {
    const relative = text(object(value).path);
    return object(JSON.parse(read(relative)));
  };
  return { thread, raw, payload };
}
function readCostEvent(
  line: string,
  index: number,
  thread: string,
  isClosed: boolean,
): JsonObject {
  const row = object(JSON.parse(line));
  if (
    isClosed ||
    row.schema_version !== 2 ||
    row.seq !== index + 1 ||
    row.rollout_id !== thread ||
    (row.thread_id !== null && row.thread_id !== thread)
  )
    throw new Error('Invalid cost trace sequence');
  return object(row.payload);
}
interface CostTraceState {
  starts: Map<string, { model: string; tier: string }>;
  ended: Set<string>;
  requests: Map<string, RequestEstimate>;
  failures: number;
  isClosed: boolean;
}
function recordCostEvent(
  event: JsonObject,
  payload: (value: unknown) => JsonObject,
  state: CostTraceState,
): void {
  switch (event.type) {
    case 'inference_started': {
      const id = text(event.inference_call_id);
      if (state.starts.has(id) || event.provider_name !== 'OpenAI')
        throw new Error('Duplicate or foreign inference');
      const request = payload(event.request_payload);
      const model = text(event.model);
      if (request.model !== model) throw new Error('Cost model mismatch');
      state.starts.set(id, {
        model,
        tier:
          request.service_tier == null ? 'default' : text(request.service_tier),
      });

      return;
    }
    case 'inference_completed':
    case 'inference_failed': {
      const id = text(event.inference_call_id);
      const start = state.starts.get(id);
      if (!start || state.ended.has(id))
        throw new Error('Invalid cost inference pair');
      state.ended.add(id);
      if (event.type === 'inference_failed') {
        state.failures++;
        return;
      }
      const response = payload(event.response_payload);
      const tokens = object(response.token_usage);
      const request: RequestEstimate = {
        id: text(event.upstream_request_id ?? event.response_id ?? id),
        ...start,
        input: tokens.input_tokens as number,
        cachedInput: tokens.cached_input_tokens as number,
        output: tokens.output_tokens as number,
        cacheWrite: tokens.cache_write_input_tokens as number,
      };
      const previous = state.requests.get(request.id);
      if (previous && contentIdentity(previous) !== contentIdentity(request))
        throw new Error('Conflicting cost request identity');
      state.requests.set(request.id, request);

      return;
    }
    case 'rollout_ended': {
      state.isClosed = true;
      // No default
      break;
    }
  }
}

/**
Read captured native requests only; no scan of HOME, credentials or unrelated sessions.
*/
export function estimateTraceCost(
  capture: {
    files: Snapshot;
    evidence: {
      threadId: string | null;
      status: string;
      tokensComplete: boolean;
    };
  },
  usage: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    complete: boolean;
  } | null,
  pricingIdentity = apiPricingIdentity,
): TraceCost {
  const unknown = (reason: string): TraceCost => ({
    observedUsd: 0,
    totalUsd: null,
    pricedRequests: 0,
    unpricedRequests: 1,
    complete: false,
    reason,
  });
  try {
    const { thread, raw, payload } = readCostCapture(capture);
    const state: CostTraceState = {
      starts: new Map(),
      ended: new Set(),
      requests: new Map(),
      failures: 0,
      isClosed: false,
    };
    for (const [index, line] of raw.trimEnd().split('\n').entries()) {
      const event = readCostEvent(line, index, thread, state.isClosed);
      recordCostEvent(event, payload, state);
    }
    const { starts, ended, requests, failures, isClosed } = state;
    const values = requests.values().toArray();
    const prices = values.map((request) =>
      estimateRequestUsd(request, pricingIdentity),
    );
    const pricedRequests = prices.filter((p) => p !== null).length;
    const unpricedRequests =
      prices.length - pricedRequests + failures + starts.size - ended.size;
    const totals = values.reduce(
      (s, v) => ({
        input: s.input + v.input,
        cachedInput: s.cachedInput + v.cachedInput,
        output: s.output + v.output,
      }),
      { input: 0, cachedInput: 0, output: 0 },
    );
    if (
      !usage ||
      totals.input !== usage.inputTokens ||
      totals.cachedInput !== usage.cachedInputTokens ||
      totals.output !== usage.outputTokens
    )
      throw new Error('Cost tokens disagree with recorded usage');
    const observedUsd = prices.reduce<number>((s, p) => s + (p ?? 0), 0);
    const isComplete =
      isClosed &&
      starts.size > 0 &&
      unpricedRequests === 0 &&
      usage.complete &&
      capture.evidence.status === 'complete' &&
      capture.evidence.tokensComplete;
    return {
      observedUsd,
      totalUsd: isComplete ? observedUsd : null,
      pricedRequests,
      unpricedRequests,
      complete: isComplete,
      reason: isComplete ? null : 'Partial trace or unpriced requests',
    };
  } catch (error) {
    return unknown(
      error instanceof Error ? error.message : 'Unknown cost evidence',
    );
  }
}

export function summarizeCosts(rows: TraceCost[]): CostMeasurement {
  const observedUsd = rows.reduce((sum, row) => sum + row.observedUsd, 0);
  const completeAttempts = rows.filter((row) => row.complete).length;
  return {
    observedUsd,
    totalUsd:
      completeAttempts === rows.length && rows.length > 0 ? observedUsd : null,
    attempts: rows.length,
    completeAttempts,
    pricedRequests: rows.reduce((s, r) => s + r.pricedRequests, 0),
    unpricedRequests: rows.reduce((s, r) => s + r.unpricedRequests, 0),
  };
}
