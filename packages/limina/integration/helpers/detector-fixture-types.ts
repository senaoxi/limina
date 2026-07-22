import type { LiminaCheckIssueCode } from '../../src/check-reporting/codes';
import type {
  LiminaCheckRunResult,
  LiminaCheckRunTaskStatus,
  LiminaCheckTaskName,
} from '../../src/check-reporting/snapshot';

export const FIXTURE_TOOL_NAMES = [
  'typescript',
  'tsgo',
  'vue-tsc',
  'vue-tsgo',
  'svelte-check',
  'knip',
  'publint',
  'attw',
  'npm-package-json-lint',
] as const;

export type FixtureToolName = (typeof FIXTURE_TOOL_NAMES)[number];

export const FAULT_INJECTION_POINTS = [
  'cleanup.execute',
  'execution.finalize',
  'filesystem.close',
  'filesystem.fsync',
  'filesystem.read',
  'filesystem.rename',
  'filesystem.write',
  'process.protocol',
  'process.spawn',
  'process.stderr',
  'process.stdout',
  'process.wait',
  'snapshot.install',
  'snapshot.serialize',
  'snapshot.write',
  'task.execute',
] as const;

export type FaultInjectionPoint = (typeof FAULT_INJECTION_POINTS)[number];

export type FaultInjection =
  | {
      readonly code?: string;
      readonly kind: 'stream-error';
      readonly stream: 'stderr' | 'stdout';
    }
  | {
      readonly exitCode: number;
      readonly kind: 'process-exit';
    }
  | {
      readonly kind: 'process-signal';
      readonly signal: NodeJS.Signals;
    }
  | {
      readonly kind: 'timeout';
    }
  | {
      readonly kind: 'invalid-protocol';
      readonly payload: string;
    }
  | {
      readonly code?: string;
      readonly kind: 'throw';
      readonly message: string;
      readonly name: string;
    };

export interface FaultInjectionDefinition {
  readonly fault: FaultInjection;
  readonly occurrence?: number;
  readonly point: FaultInjectionPoint;
  readonly task: LiminaCheckTaskName;
}

export interface FixtureCopyPolicy {
  readonly excludedNames?: readonly string[];
  readonly includeBuildInfoFiles?: boolean;
  readonly includeOutputDirectories?: boolean;
}

export type FixtureSetupOperation =
  | {
      readonly kind: 'directory-link';
      readonly path: string;
      readonly target: string;
    }
  | {
      readonly content: string;
      readonly kind: 'write-file';
      readonly overwrite?: boolean;
      readonly path: string;
    }
  | {
      readonly allowMissing?: boolean;
      readonly kind: 'remove-path';
      readonly path: string;
    };

export type FixtureMutation =
  | {
      readonly content: string;
      readonly kind: 'write-file';
      readonly overwrite?: boolean;
      readonly path: string;
    }
  | {
      readonly all?: boolean;
      readonly kind: 'replace-text';
      readonly path: string;
      readonly replacement: string;
      readonly search: string;
    }
  | {
      readonly allowMissing?: boolean;
      readonly kind: 'remove-path';
      readonly path: string;
    };

export interface ExpectedEvidence {
  readonly label?: string;
  readonly lines?: readonly string[];
  readonly value?: string;
}

export interface ExpectedLocation {
  readonly column?: number;
  readonly filePath?: string;
  readonly label?: string;
  readonly line?: number;
  readonly packageManifestPath?: string;
  readonly scope?: string;
}

export interface ExpectedIssue {
  readonly checkerName?: string;
  readonly code: LiminaCheckIssueCode;
  readonly evidence?: readonly ExpectedEvidence[];
  readonly externalCode?: string;
  readonly filePath?: string;
  readonly locations?: readonly ExpectedLocation[];
  readonly packageManifestPath?: string;
  readonly packageName?: string;
  readonly reason?: string;
  readonly scope?: string;
  readonly task: LiminaCheckTaskName;
}

export interface ExpectedStreamOutput {
  readonly linesInOrder?: readonly string[];
}

export interface ExpectedSnapshot {
  readonly complete?: boolean;
  readonly expected: boolean;
}

export interface ExpectedFaultBoundary {
  readonly cleanupDescriptorCount?: number;
  readonly cleanupDirectoryDescriptorCount?: number;
  readonly cleanupFileDescriptorCount?: number;
  readonly cleanupGenerationCount?: number;
  readonly cleanupResourcesRemoved?: number;
  readonly flowCleanupAttempts?: number;
  readonly flowCleanupCompleted?: boolean;
  readonly flowResourcesClosed?: boolean;
  readonly removedTempFiles?: number;
  readonly tempCleanupAttempts?: number;
  readonly tempCleanupCompleted?: boolean;
}

export interface ExpectedFaultError {
  readonly code?: string;
  readonly expected: boolean;
  readonly name?: string;
}

export interface LocalRegistryPackageFile {
  readonly content: string;
  readonly path: string;
}

export type LocalRegistryDigestDeclaration =
  | { readonly kind: 'actual' }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'omit' }
  | { readonly kind: 'value'; readonly value: unknown };

export type LocalRegistryResponseBody =
  | {
      readonly kind: 'bytes';
      readonly valueBase64: string;
    }
  | {
      readonly kind: 'close-connection';
    }
  | {
      readonly kind: 'delay';
      readonly milliseconds: number;
      readonly next: LocalRegistryResponseBody;
    }
  | {
      readonly kind: 'incomplete-body';
      readonly value: string;
    }
  | {
      readonly kind: 'json';
      readonly value: unknown;
    }
  | {
      readonly files: readonly LocalRegistryPackageFile[];
      readonly kind: 'package-tarball';
    }
  | {
      readonly distTag?: string;
      readonly integrity: LocalRegistryDigestDeclaration;
      readonly kind: 'package-metadata';
      readonly shasum?: LocalRegistryDigestDeclaration;
      readonly tarballPath?: string;
      readonly version: string;
    }
  | {
      readonly kind: 'text';
      readonly value: string;
    };

export interface LocalRegistryResponse {
  readonly body: LocalRegistryResponseBody;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}

export interface ExpectedRegistryRequest {
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: 'GET';
  readonly pathname: string;
}

export interface LocalRegistryScenario {
  readonly expectedRequests: readonly ExpectedRegistryRequest[];
  readonly metadata: LocalRegistryResponse;
  readonly packageName: string;
  readonly requestTimeoutMs?: number;
  readonly tarballs?: Readonly<Record<string, LocalRegistryResponse>>;
}

export interface DetectorFixtureExpectation {
  readonly additionalCodes?: readonly LiminaCheckIssueCode[];
  readonly allowUnexpectedIssues?: boolean;
  readonly boundary?: ExpectedFaultBoundary;
  readonly error?: ExpectedFaultError;
  readonly exitCode: number;
  readonly issues: readonly ExpectedIssue[];
  readonly primaryCode?: LiminaCheckIssueCode;
  readonly runOutcome?: LiminaCheckRunResult;
  readonly snapshot?: ExpectedSnapshot;
  readonly stderr?: ExpectedStreamOutput;
  readonly stdout?: ExpectedStreamOutput;
  readonly taskStates?: Readonly<
    Partial<Record<LiminaCheckTaskName, LiminaCheckRunTaskStatus>>
  >;
}

export interface DetectorFixtureDefinition {
  readonly allowedGeneratedPaths?: readonly string[];
  readonly command: readonly string[];
  readonly copyPolicy?: FixtureCopyPolicy;
  readonly environment?: Readonly<Record<string, string>>;
  readonly expected: DetectorFixtureExpectation;
  readonly fault?: FaultInjectionDefinition;
  readonly id: string;
  readonly kind: 'external-tool' | 'fault-injection' | 'filesystem';
  readonly mutations?: readonly FixtureMutation[];
  readonly registry?: LocalRegistryScenario;
  readonly secondaryFault?: FaultInjectionDefinition;
  readonly setup?: readonly FixtureSetupOperation[];
  readonly tools?: readonly FixtureToolName[];
}

export function defineDetectorFixture<
  const Definition extends DetectorFixtureDefinition,
>(definition: Definition): Definition {
  return definition;
}
