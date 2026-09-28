export interface CrossProcessLeaseOwner {
  hostname: string;
  pid: number;
  startedAt: string;
  token: string;
}

export interface CrossProcessLease {
  owner: CrossProcessLeaseOwner;
  release(): Promise<void>;
  type: 'reader' | 'writer';
}

export interface CrossProcessLeaseOptions {
  leaseName?: string;
  timeoutMs?: number;
}

export class CrossProcessLeaseTimeoutError extends Error {
  override readonly name = 'CrossProcessLeaseTimeoutError';
}

export class CrossProcessLeaseCorruptError extends Error {
  override readonly name = 'CrossProcessLeaseCorruptError';
}
