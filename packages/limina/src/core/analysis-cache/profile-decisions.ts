import { currentProfile } from '../../application/analysis/observability';
import type { CacheCause } from '../../application/analysis/observability-types';

export type CacheOrigin =
  | 'prior-disk'
  | 'invocation-memory'
  | 'mixed'
  | 'unknown';

export function cacheCause(
  decision: string | undefined,
  code: string,
): CacheCause {
  return decision === undefined ? { code } : { decision };
}

export function recordCacheHit(
  layer: string,
  origin: CacheOrigin,
  file?: string,
): string | undefined {
  const profile = currentProfile();
  if (profile === undefined) return undefined;
  const subject = file === undefined ? undefined : profile.path(file);
  const lookup = profile.decision(
    layer,
    { stage: 'lookup', outcome: 'found' },
    subject,
  );
  const admission = profile.decision(
    layer,
    { stage: 'admission', outcome: 'admitted', basis: [lookup] },
    subject,
  );
  return profile.decision(
    layer,
    { stage: 'adoption', outcome: 'adopted', origin, basis: [admission] },
    subject,
  );
}

export function recordCacheMiss(
  layer: string,
  code: string,
  options?: {
    file?: string;
    absent?: true;
    bypassed?: true;
    input?: { kind: string; file: string };
    cause?: string;
    basis?: string;
  },
): string | undefined {
  const profile = currentProfile();
  if (profile === undefined) return undefined;
  const subject =
    options?.file === undefined ? undefined : profile.path(options.file);
  const causes: readonly [CacheCause] = [
    options?.cause === undefined && options?.input !== undefined
      ? {
          code,
          input: {
            kind: options.input.kind,
            ref: profile.path(options.input.file),
          },
        }
      : cacheCause(options?.cause, code),
  ];
  const basis = options?.basis === undefined ? undefined : [options.basis];
  const lookup =
    options?.absent || options?.bypassed
      ? undefined
      : profile.decision(
          layer,
          { stage: 'lookup', outcome: 'found', basis },
          subject,
        );
  const reason = options?.absent
    ? profile.decision(
        layer,
        { stage: 'lookup', outcome: 'absent', causes, basis },
        subject,
      )
    : profile.decision(
        layer,
        {
          stage: 'admission',
          outcome: options?.bypassed ? 'bypassed' : 'rejected',
          causes,
          basis: lookup === undefined ? basis : [lookup],
        },
        subject,
      );
  return profile.decision(
    layer,
    {
      stage: 'adoption',
      outcome: 'not-adopted',
      causes: [{ decision: reason }],
    },
    subject,
  );
}
