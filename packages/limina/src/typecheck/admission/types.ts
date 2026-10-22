import type { GraphFinding } from '../../graph-check/findings';
import type { CheckerTargetId } from '../target-types';

export type ExecutionStage = 'mutation' | 'launch' | 'output-copy';
export interface ExecutionAdmissionDiagnostic {
  code: string;
  message: string;
  finding?: Omit<GraphFinding, 'task'>;
}
export interface ExecutionAdmissionRejection {
  status: 'admission-rejected';
  id: CheckerTargetId;
  stage: ExecutionStage;
  decision: 'denied' | 'unavailable';
  diagnostics: readonly ExecutionAdmissionDiagnostic[];
}
declare const permitBrand: unique symbol;
export interface ExecutionPermit {
  readonly [permitBrand]: true;
}
export type AuthorizedResult<T> =
  | { state: 'executed'; value: T }
  | { state: 'refused'; rejection: ExecutionAdmissionRejection };
