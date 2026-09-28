import { LIMINA_CHECK_ISSUE_CODES, type LiminaCheckIssueCode } from '../codes';
import type { LiminaCheckTaskName } from '../snapshot';

export type DetectorCoverageEntry = { readonly task: LiminaCheckTaskName } & (
  | {
      readonly kind: 'external-tool' | 'fixture' | 'integration';
      readonly producers: readonly string[];
      readonly tests: readonly string[];
    }
  | {
      readonly kind: 'unit';
      readonly producers: readonly string[];
      readonly reason: string;
      readonly tests: readonly string[];
    }
  | {
      readonly kind: 'fault-injection';
      readonly producers: readonly string[];
      readonly tests: readonly string[];
    }
  | {
      readonly kind: 'planned';
      readonly producers: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: 'retired';
      readonly reason: string;
    }
);

export type DetectorCoverageRegistry = Readonly<
  Record<LiminaCheckIssueCode, DetectorCoverageEntry>
>;

export type PartialDetectorCoverageRegistry = Readonly<
  Partial<Record<LiminaCheckIssueCode, DetectorCoverageEntry>>
>;

function mergeDetectorCoverageParts(
  parts: readonly PartialDetectorCoverageRegistry[],
): Partial<Record<LiminaCheckIssueCode, DetectorCoverageEntry>> {
  return Object.assign({}, ...parts);
}

function getMissingDetectorCoverageCodes(
  registry: Partial<Record<LiminaCheckIssueCode, DetectorCoverageEntry>>,
): LiminaCheckIssueCode[] {
  return Object.values(LIMINA_CHECK_ISSUE_CODES).filter(
    (code) => registry[code] === undefined,
  );
}

function assertCompleteDetectorCoverageRegistry(
  registry: Partial<Record<LiminaCheckIssueCode, DetectorCoverageEntry>>,
): asserts registry is Record<LiminaCheckIssueCode, DetectorCoverageEntry> {
  const missingCodes = getMissingDetectorCoverageCodes(registry);
  if (missingCodes.length === 0) return;
  throw new Error(
    `Detector coverage registry is missing issue codes: ${missingCodes.join(', ')}.`,
  );
}

export function completeDetectorCoverageRegistry(
  parts: readonly PartialDetectorCoverageRegistry[],
): DetectorCoverageRegistry {
  const registry = mergeDetectorCoverageParts(parts);
  assertCompleteDetectorCoverageRegistry(registry);
  return registry;
}

export interface DetectorScenarioCoverageEntry {
  readonly fixturePath: string;
  readonly kind: 'fault-boundary' | 'passing-control';
  readonly reason: string;
}

export type DetectorScenarioCoverageRegistry = Readonly<
  Record<string, DetectorScenarioCoverageEntry>
>;
