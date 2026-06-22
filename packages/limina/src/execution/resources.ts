export interface ResourceRequest {
  exclusive?: readonly string[];
  read?: readonly string[];
  write?: readonly string[];
}

interface ResourceLock {
  ownerId: string;
  request: NormalizedResourceRequest;
}

interface NormalizedResourceRequest {
  exclusive: Set<string>;
  read: Set<string>;
  write: Set<string>;
}

function normalizeResourceRequest(
  request: ResourceRequest,
): NormalizedResourceRequest {
  return {
    exclusive: new Set(request.exclusive),
    read: new Set(request.read),
    write: new Set(request.write),
  };
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }

  return false;
}

function hasConflict(
  left: NormalizedResourceRequest,
  right: NormalizedResourceRequest,
): boolean {
  return (
    intersects(left.exclusive, right.exclusive) ||
    intersects(left.exclusive, right.read) ||
    intersects(left.exclusive, right.write) ||
    intersects(left.read, right.exclusive) ||
    intersects(left.read, right.write) ||
    intersects(left.write, right.exclusive) ||
    intersects(left.write, right.read) ||
    intersects(left.write, right.write)
  );
}

export class ResourceLockSet {
  readonly #locks: ResourceLock[] = [];

  acquire(ownerId: string, request: ResourceRequest): void {
    if (this.#locks.some((lock) => lock.ownerId === ownerId)) {
      throw new Error(`Resource owner "${ownerId}" already holds locks.`);
    }

    if (!this.canAcquire(request)) {
      throw new Error(`Unable to acquire resources for "${ownerId}".`);
    }

    this.#locks.push({
      ownerId,
      request: normalizeResourceRequest(request),
    });
  }

  canAcquire(request: ResourceRequest): boolean {
    const normalizedRequest = normalizeResourceRequest(request);

    return this.#locks.every(
      (lock) => !hasConflict(lock.request, normalizedRequest),
    );
  }

  release(ownerId: string): void {
    const lockIndex = this.#locks.findIndex((lock) => lock.ownerId === ownerId);

    if (lockIndex === -1) {
      return;
    }

    this.#locks.splice(lockIndex, 1);
  }
}
