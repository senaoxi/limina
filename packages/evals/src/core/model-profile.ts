import { contentIdentity } from './identity.ts';

export const reasoningEfforts = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export interface ModelProfile {
  version: 1;
  id: string;
  canonicalModelId: string;
  displayName: string;
  providerId: 'openai';
  reasoningEffort: (typeof reasoningEfforts)[number];
  requestedServiceTier: 'default';
  supportedEfforts: string[];
  capabilitiesDigest: string;
  instructionDigest: string;
  execution: {
    contextWindow: number;
    autoCompactTokenLimit: number;
    toolOutputLimit: number;
  };
  codex: { version: string; sha256: string; codeModeHostSha256: string };
}
export function assertDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value))
    throw new Error('Expected SHA-256 identity');
}
export function createModelProfile(
  input: Omit<ModelProfile, 'version' | 'id'>,
): ModelProfile {
  if (
    !/^[a-z\d][a-z\d.-]{1,79}$/.test(input.canonicalModelId) ||
    !/^[\p{L}\p{N} .()+-]{1,80}$/u.test(input.displayName) ||
    input.providerId !== 'openai' ||
    input.requestedServiceTier !== 'default' ||
    !reasoningEfforts.includes(input.reasoningEffort) ||
    !input.supportedEfforts.includes(input.reasoningEffort) ||
    new Set(input.supportedEfforts).size !== input.supportedEfforts.length ||
    input.supportedEfforts.some(
      (entry) =>
        !reasoningEfforts.includes(entry as ModelProfile['reasoningEffort']),
    ) ||
    !/^\d+\.\d+\.\d+$/.test(input.codex.version)
  )
    throw new Error('Invalid or unsupported model profile');
  for (const d of [
    input.capabilitiesDigest,
    input.instructionDigest,
    input.codex.sha256,
    input.codex.codeModeHostSha256,
  ])
    assertDigest(d);
  const x = input.execution;
  if (
    [x.contextWindow, x.autoCompactTokenLimit, x.toolOutputLimit].some(
      (v) => !(Number.isSafeInteger(v) && v > 0),
    ) ||
    x.autoCompactTokenLimit >= x.contextWindow
  )
    throw new Error('Invalid common execution limits');
  const body = {
    version: 1 as const,
    ...structuredClone(input),
    supportedEfforts: [...input.supportedEfforts].toSorted((a, b) =>
      a.localeCompare(b),
    ),
  };
  const execution: Omit<typeof body, 'displayName'> & { displayName?: string } =
    { ...body };
  delete execution.displayName;
  return { ...body, id: contentIdentity(execution) };
}
export function verifyModelProfile(profile: ModelProfile): void {
  const { id, version, ...input } = profile;
  if (
    version !== 1 ||
    contentIdentity(createModelProfile(input)) !== contentIdentity(profile)
  )
    throw new Error('Model profile identity changed');
  assertDigest(id);
}
export function verifyProfileBinary(
  profile: ModelProfile,
  codex: ModelProfile['codex'],
): void {
  verifyModelProfile(profile);
  if (
    contentIdentity(profile.codex) !==
    contentIdentity({
      version: codex.version,
      sha256: codex.sha256,
      codeModeHostSha256: codex.codeModeHostSha256,
    })
  )
    throw new Error('Profile Codex binary differs');
}

// A catalog is capability evidence, never an account entitlement or an execution receipt.
export function verifyProfileCatalog(
  profile: ModelProfile,
  models: Record<string, unknown>[],
): void {
  verifyModelProfile(profile);
  const matches = models.filter((m) => m.slug === profile.canonicalModelId);
  if (matches.length !== 1)
    throw new Error('Exact model absent from pinned catalog');
  const m = matches[0]!;
  const efforts = (
    m.supported_reasoning_levels as { effort: string }[] | undefined
  )
    ?.map((x) => x.effort)
    .toSorted((a, b) => a.localeCompare(b));
  if (
    contentIdentity(m) !== profile.capabilitiesDigest ||
    contentIdentity({
      base: m.base_instructions ?? null,
      messages: m.model_messages ?? null,
    }) !== profile.instructionDigest ||
    contentIdentity(efforts ?? []) !==
      contentIdentity(profile.supportedEfforts) ||
    m.shell_type !== 'unified_exec' ||
    m.apply_patch_tool_type !== 'freeform' ||
    (m.truncation_policy as { limit?: number } | undefined)?.limit !==
      profile.execution.toolOutputLimit ||
    typeof m.context_window !== 'number' ||
    m.context_window < profile.execution.contextWindow
  )
    throw new Error('Pinned model capabilities differ from profile');
}
