import type { UsageRecord } from '../core/budget.ts';
import {
  type ModelProfile,
  verifyModelProfile,
} from '../core/model-profile.ts';
import { captureSnapshot, type Snapshot } from '../core/snapshot.ts';
import { hasAgentInstructions } from './local-codex.ts';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('TRACE_OBJECT_REQUIRED');
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw new Error('TRACE_TEXT_REQUIRED');
  return value;
}

export interface NativeTraceEvidence {
  status: 'complete' | 'partial' | 'unknown';
  digest: string | null;
  threadId: string | null;
  toolCalls: number;
  inferenceCalls: number;
  failedInferenceCalls: number;
  tokens: { input: number; cachedInput: number; output: number } | null;
  tokensComplete: boolean;
  errors: string[];
  observedModelIds?: string[];
  modelProfileId?: string;
  instructionPolicy?: 'isolated-auth-only-v1';
}

/**
The CLI owns this continuously written directory outside the Agent sandbox.
A complete stdout event stream alone cannot prove complete Code Mode dispatch.
*/
export async function collectNativeTrace(
  root: string,
  expectedThreadId: string | null,
  usage: UsageRecord,
  profile?: ModelProfile,
  instructionPolicy?: { forbidAgentInstructions: true },
): Promise<{ evidence: NativeTraceEvidence; files: Snapshot }> {
  const files = await captureSnapshot(root, 'S1');
  const evidence: NativeTraceEvidence = {
    status: files.entries.length > 0 ? 'partial' : 'unknown',
    digest: files.digest,
    threadId: null,
    toolCalls: 0,
    inferenceCalls: 0,
    failedInferenceCalls: 0,
    tokens: null,
    tokensComplete: false,
    errors: [],
    observedModelIds: [],
    ...(profile && { modelProfileId: profile.id }),
    ...(instructionPolicy && {
      instructionPolicy: 'isolated-auth-only-v1' as const,
    }),
  };
  try {
    if (profile) verifyModelProfile(profile);
    if (files.status !== 'complete')
      throw new Error('TRACE_CAPTURE_INCOMPLETE');
    const contents = new Map(
      files.entries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => [
          entry.path,
          Buffer.from(entry.content, 'base64').toString('utf8'),
        ]),
    );
    if (files.entries.some((entry) => entry.kind === 'symlink'))
      throw new Error('TRACE_SYMLINK');
    const manifests = contents
      .keys()
      .filter((file) => /^[^/]+\/manifest\.json$/.test(file))
      .toArray();
    if (manifests.length !== 1) throw new Error('TRACE_SESSION_COUNT');
    const manifestPath = manifests[0]!;
    const prefix = manifestPath.slice(0, -'manifest.json'.length);
    const readJson = (relative: string) => {
      if (!/^(?:manifest\.json|payloads\/\d+\.json)$/.test(relative))
        throw new Error('TRACE_PAYLOAD_PATH');
      const content = contents.get(prefix + relative);
      if (content === undefined) throw new Error('TRACE_PAYLOAD_MISSING');
      return record(JSON.parse(content));
    };
    const manifest = readJson('manifest.json');
    if (
      manifest.schema_version !== 2 ||
      manifest.raw_event_log !== 'trace.jsonl' ||
      manifest.payloads_dir !== 'payloads'
    )
      throw new Error('TRACE_SCHEMA');
    const threadId = text(manifest.root_thread_id);
    evidence.threadId = threadId;
    if (threadId !== expectedThreadId || manifest.rollout_id !== threadId)
      throw new Error('TRACE_SESSION_CHANGED');
    const raw = contents.get(`${prefix}trace.jsonl`);
    if (!raw?.endsWith('\n')) throw new Error('TRACE_TRUNCATED');
    const rows = raw
      .trimEnd()
      .split('\n')
      .map((line) => record(JSON.parse(line)));
    const calls = new Set<string>();
    const finishedCalls = new Set<string>();
    const inferences = new Set<string>();
    const finishedInferences = new Set<string>();
    const failedInferences = new Set<string>();
    const totals = { input: 0, cachedInput: 0, output: 0 };
    let isConfigured = false;
    let isEnded = false;
    const referenced = new Set<string>();
    const payload = (value: unknown) => {
      const relative = text(record(value).path);
      referenced.add(prefix + relative);
      return readJson(relative);
    };
    for (const [index, row] of rows.entries()) {
      if (
        row.schema_version !== 2 ||
        row.seq !== index + 1 ||
        row.rollout_id !== threadId ||
        (row.thread_id !== null && row.thread_id !== threadId)
      )
        throw new Error('TRACE_SEQUENCE_OR_SESSION');
      const event = record(row.payload);
      // Validate every payload reference, including protocol and code-cell events.
      for (const value of Object.values(event)) {
        if (value && typeof value === 'object' && 'raw_payload_id' in value)
          payload(value);
      }
      if (
        event.type === 'thread_started' &&
        (event.thread_id !== threadId || event.agent_path !== '/root')
      )
        throw new Error('TRACE_SUBAGENT');
      if (
        event.type === 'protocol_event_observed' &&
        event.event_type === 'session_configured'
      ) {
        const session = payload(event.event_payload);
        if (
          typeof session.model === 'string' &&
          !evidence.observedModelIds!.includes(session.model)
        )
          evidence.observedModelIds!.push(session.model);
        const permissions = record(session.permission_profile);
        if (
          isConfigured ||
          session.session_id !== threadId ||
          session.model !== (profile?.canonicalModelId ?? 'gpt-6.1-terra') ||
          session.model_provider_id !== (profile?.providerId ?? 'openai') ||
          session.approval_policy !== 'never' ||
          session.reasoning_effort !== (profile?.reasoningEffort ?? 'high') ||
          record(session.active_permission_profile).id !== 'limina-eval' ||
          permissions.type !== 'managed' ||
          permissions.network !== 'restricted' ||
          record(permissions.file_system).type !== 'restricted'
        )
          throw new Error('TRACE_EXECUTION_CONFIGURATION');
        isConfigured = true;
      }
      switch (event.type) {
        case 'tool_call_started': {
          const id = text(event.tool_call_id);
          if (
            calls.has(id) ||
            !['exec_command', 'write_stdin', 'apply_patch'].includes(
              text(record(event.kind).type),
            )
          )
            throw new Error('TRACE_TOOL_NOT_ADMITTED');
          calls.add(id);

          continue;
        }
        case 'tool_call_ended': {
          const id = text(event.tool_call_id);
          if (!calls.has(id) || finishedCalls.has(id))
            throw new Error('TRACE_TOOL_PAIR');
          finishedCalls.add(id);

          continue;
        }
        case 'inference_started': {
          const id = text(event.inference_call_id);
          if (
            typeof event.model === 'string' &&
            !evidence.observedModelIds!.includes(event.model)
          )
            evidence.observedModelIds!.push(event.model);
          if (
            inferences.has(id) ||
            event.model !== (profile?.canonicalModelId ?? 'gpt-6.1-terra') ||
            event.provider_name !== 'OpenAI'
          )
            throw new Error('TRACE_MODEL_CHANGED');
          const request = payload(event.request_payload);
          if (
            instructionPolicy &&
            (!Array.isArray(request.input) ||
              hasAgentInstructions(request.input))
          )
            throw new Error('TRACE_UNEXPECTED_AGENT_INSTRUCTIONS');
          if (
            typeof request.model === 'string' &&
            !evidence.observedModelIds!.includes(request.model)
          )
            evidence.observedModelIds!.push(request.model);
          if (
            request.model !== event.model ||
            record(request.reasoning).effort !==
              (profile?.reasoningEffort ?? 'high') ||
            ![undefined, null, 'default'].includes(
              request.service_tier as string | null | undefined,
            )
          )
            throw new Error('TRACE_MODEL_CONFIGURATION');
          inferences.add(id);

          continue;
        }
        case 'inference_completed': {
          const id = text(event.inference_call_id);
          if (!inferences.has(id) || finishedInferences.has(id))
            throw new Error('TRACE_INFERENCE_PAIR');
          const response = payload(event.response_payload);
          if (
            typeof response.model === 'string' &&
            !evidence.observedModelIds!.includes(response.model)
          )
            evidence.observedModelIds!.push(response.model);
          if (
            response.model !== undefined &&
            response.model !== (profile?.canonicalModelId ?? 'gpt-6.1-terra')
          )
            throw new Error('TRACE_RESPONSE_MODEL_CHANGED');
          if (
            response.service_tier !== undefined &&
            response.service_tier !== null &&
            response.service_tier !== 'default'
          )
            throw new Error('TRACE_RESPONSE_TIER_CHANGED');
          const tokens = record(response.token_usage);
          for (const [key, source] of [
            ['input', 'input_tokens'],
            ['cachedInput', 'cached_input_tokens'],
            ['output', 'output_tokens'],
          ] as const) {
            const value = tokens[source];
            if (
              typeof value !== 'number' ||
              !Number.isSafeInteger(value) ||
              value < 0
            )
              throw new Error('TRACE_USAGE_UNKNOWN');
            totals[key] += value;
          }
          finishedInferences.add(id);

          continue;
        }
        case 'inference_failed': {
          const id = text(event.inference_call_id);
          if (!inferences.has(id) || finishedInferences.has(id))
            throw new Error('TRACE_INFERENCE_PAIR');
          text(event.error);
          finishedInferences.add(id);
          failedInferences.add(id);

          continue;
        }
        // No default
      }
      if (event.type !== 'rollout_ended') {
        continue;
      }

      if (isEnded || index !== rows.length - 1)
        throw new Error('TRACE_END_POSITION');
      isEnded = true;
    }
    evidence.toolCalls = calls.size;
    evidence.inferenceCalls = inferences.size;
    evidence.failedInferenceCalls = failedInferences.size;
    if (
      !isConfigured ||
      !isEnded ||
      inferences.size === 0 ||
      calls.size !== finishedCalls.size ||
      inferences.size !== finishedInferences.size
    )
      throw new Error('TRACE_LIFECYCLE_INCOMPLETE');
    if (
      totals.input !== usage.inputTokens ||
      totals.cachedInput !== usage.cachedInputTokens ||
      totals.output !== usage.outputTokens ||
      totals.cachedInput > totals.input
    )
      throw new Error('TRACE_USAGE_MISMATCH');
    if (
      contents
        .keys()
        .some((p) => p.startsWith(`${prefix}payloads/`) && !referenced.has(p))
    )
      throw new Error('TRACE_UNREFERENCED_PAYLOAD');
    evidence.tokens = totals;
    evidence.tokensComplete = failedInferences.size === 0;
    evidence.status = 'complete';
    evidence.observedModelIds = [profile?.canonicalModelId ?? 'gpt-6.1-terra'];
    if (profile) evidence.modelProfileId = profile.id;
  } catch (error) {
    evidence.errors.push(
      error instanceof Error ? error.message : 'TRACE_UNKNOWN',
    );
  }
  return { evidence, files };
}
