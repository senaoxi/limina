import type { ConfigModuleEvidence } from '../config/input-observation';
import type { ConfigModuleSnapshot } from '../core/analysis-cache/contracts';
import { CliLogger } from '../logger';
function warn(
  evidence: ConfigModuleEvidence,
  key: string,
  message: string,
): void {
  if (evidence.warned.has(key)) return;
  evidence.warned.add(key);
  CliLogger.warn(message);
  evidence.metrics.warnings = (evidence.metrics.warnings ?? 0) + 1;
}
export function warnConfigModuleCoverage(
  evidence: ConfigModuleEvidence,
  snapshot: ConfigModuleSnapshot,
): void {
  for (const reason of snapshot.otherUnknownReasons)
    warn(
      evidence,
      reason,
      `Configuration module coverage is incomplete (${reason}). Checking continues with a cold analysis cache.`,
    );
}
