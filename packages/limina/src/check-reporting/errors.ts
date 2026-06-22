import type { LiminaCheckIssue } from './snapshot';

export class LiminaStructuredError extends Error {
  override readonly name = 'LiminaStructuredError';
  readonly issues: LiminaCheckIssue[];

  constructor(message: string, issues: readonly LiminaCheckIssue[]) {
    super(message);
    this.issues = [...issues];
  }
}
