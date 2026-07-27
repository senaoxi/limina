import type {
  LiminaCheckIssueEvidence,
  LiminaCheckIssueExternal,
  LiminaCheckIssueLocation,
} from '../../../check-reporting/snapshot';
import type {
  ReleaseFindingFactsByCode,
  ReleaseSemanticIssueCode,
} from './facts';

export type ReleaseFindingSection =
  | 'output-manifest'
  | 'packed-lint'
  | 'packed-manifest'
  | 'registry-content'
  | 'source-link'
  | 'source-private'
  | 'source-workspace'
  | 'tarball';

export interface ReleaseFindingPresentation {
  readonly problemLines: readonly string[];
  readonly section: ReleaseFindingSection;
  readonly sectionTitle: string;
  readonly summary: string;
  readonly title: string;
}

interface ReleaseFindingBase<Code extends ReleaseSemanticIssueCode> {
  readonly code: Code;
  readonly evidence: readonly LiminaCheckIssueEvidence[];
  readonly external?: LiminaCheckIssueExternal;
  readonly facts: ReleaseFindingFactsByCode[Code];
  readonly filePath?: string;
  readonly locations: readonly LiminaCheckIssueLocation[];
  readonly packageManifestPath: string;
  readonly packageName: string;
  readonly presentation: ReleaseFindingPresentation;
  readonly reason: ReleaseFindingFactsByCode[Code]['kind'];
  readonly task: 'release:check';
}

export type ReleaseFindingForCode<Code extends ReleaseSemanticIssueCode> =
  ReleaseFindingBase<Code>;

export type ReleaseFinding = {
  readonly [Code in ReleaseSemanticIssueCode]: ReleaseFindingForCode<Code>;
}[ReleaseSemanticIssueCode];

export interface CreateReleaseFindingOptions<
  Code extends ReleaseSemanticIssueCode,
> {
  readonly code: Code;
  readonly external?: LiminaCheckIssueExternal;
  readonly facts: ReleaseFindingFactsByCode[Code];
  readonly filePath?: string;
  readonly locations?: readonly LiminaCheckIssueLocation[];
  readonly packageManifestPath: string;
  readonly packageName: string;
  readonly presentation: ReleaseFindingPresentation;
}
