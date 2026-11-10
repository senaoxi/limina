import type { EvidenceReference } from './run-store.ts';
import type { Snapshot } from './snapshot.ts';

export interface Observation {
  state: 'yes' | 'no' | 'unknown';
  evidence: EvidenceReference[];
}
export interface ActivationEvidence {
  installed: Observation;
  discoverable: Observation;
  discovered: Observation;
  skillRead: Observation;
  referenceReads: Record<string, Observation>;
  followed: Observation;
}
const observation = (
  state: Observation['state'],
  evidence: EvidenceReference[] = [],
): Observation => ({ state, evidence });

function isDirectFileRead(command: string, file: string): boolean {
  // Parse a single direct read, not a shell program that merely mentions the path.
  const match =
    /^(?:\/bin\/)?cat\s+(?:--\s+)?(?:"([^"$`]+)"|'([^']+)'|([^\s;&|<>`$]+))$/.exec(
      command.trim(),
    );
  const target = match?.[1] ?? match?.[2] ?? match?.[3];
  return target === file || target?.endsWith(`/${file}`) === true;
}

function initialActivation(
  skill: Snapshot | null,
  isDiscoverable: boolean,
  yes: EvidenceReference[],
): ActivationEvidence {
  return {
    installed: observation(skill ? 'yes' : 'no', yes),
    discoverable: observation(isDiscoverable ? 'yes' : 'no', yes),
    discovered: observation(skill ? 'unknown' : 'no', skill ? [] : yes),
    skillRead: observation(skill ? 'unknown' : 'no', skill ? [] : yes),
    referenceReads: {},
    followed: observation(skill ? 'unknown' : 'no', skill ? [] : yes),
  };
}

/** Extract only complete-content reads from successful native tool results.
 * Visibility, file access and following advice have different authorities. */
export function observeActivation(input: {
  skill: Snapshot | null;
  discoverable: boolean;
  trace: Snapshot;
  traceComplete: boolean;
  evidence: EvidenceReference[];
}): ActivationEvidence {
  const yes = input.evidence;
  const out = initialActivation(input.skill, input.discoverable, yes);
  if (!input.skill || !input.traceComplete) return out;
  const files = new Map(
    input.trace.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => [
        entry.path,
        Buffer.from(entry.content, 'base64').toString('utf8'),
      ]),
  );
  const raw = [...files].find(([name]) => name.endsWith('/trace.jsonl'));
  if (!raw) return out;
  const prefix = raw[0].slice(0, -'trace.jsonl'.length);
  try {
    const events = raw[1]
      .trim()
      .split('\n')
      .map(
        (l) => (JSON.parse(l) as { payload: Record<string, unknown> }).payload,
      );
    const load = (reference: unknown): unknown => {
      const name = (reference as { path?: string } | undefined)?.path;
      return name && /^payloads\/\d+\.json$/.test(name)
        ? JSON.parse(files.get(prefix + name) ?? 'null')
        : null;
    };
    const results = new Map(
      events
        .filter(
          (entry) =>
            entry.type === 'tool_call_ended' && entry.status === 'completed',
        )
        .map((entry) => [entry.tool_call_id, load(entry.result_payload)]),
    );
    for (const entry of input.skill.entries) {
      if (entry.kind !== 'file' || !entry.path.endsWith('.md')) continue;
      const content = Buffer.from(entry.content, 'base64')
        .toString('utf8')
        .trim();
      const path = `.agents/skills/limina/${entry.path}`;
      const isRead =
        content.length > 0 &&
        events.some((entry) => {
          if (entry.type !== 'tool_call_started') return false;
          const invoke = load(entry.invocation_payload) as {
            tool_name?: string;
            payload?: { type?: string; arguments?: string | { cmd?: string } };
          } | null;
          if (
            invoke?.tool_name !== 'exec_command' ||
            invoke.payload?.type !== 'function'
          )
            return false;
          const arguments_ = invoke.payload.arguments;
          const command = (
            typeof arguments_ === 'string'
              ? (JSON.parse(arguments_) as { cmd?: string })
              : arguments_
          )?.cmd;
          const result = results.get(entry.tool_call_id) as
            | { value?: { exit_code?: number; output?: string } }
            | undefined;
          return (
            typeof command === 'string' &&
            isDirectFileRead(command, path) &&
            result?.value?.exit_code === 0 &&
            typeof result.value.output === 'string' &&
            result.value.output.includes(content)
          );
        });
      const value = observation(isRead ? 'yes' : 'unknown', isRead ? yes : []);
      if (entry.path === 'SKILL.md') out.skillRead = value;
      else out.referenceReads[entry.path] = value;
      if (isRead) out.discovered = observation('yes', yes);
    }
  } catch {
    /*
    Malformed or unobservable activation stays unknown, not a negative observation.
    */
  }
  return out;
}
