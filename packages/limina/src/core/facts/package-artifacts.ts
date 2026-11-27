import { normalizeAbsolutePath } from '#utils/path';
import { createHash } from 'node:crypto';

export interface CachedPackedTarball {
  readonly digest: string;
  readonly outDir: string;
  readonly tarball: Buffer;
  readonly tarballName: string;
}

/**
 * Generation-scoped read-only artifact provider for Package Check & Release Check.
 * Kept independent of Native Semantic Core so package/release workflows never
 * touch TypeScript Programs or semantic cache blocks.
 */
export class PackageArtifactProvider {
  readonly #inFlight = new Map<string, Promise<CachedPackedTarball>>();
  readonly #tarballs = new Map<string, CachedPackedTarball>();
  #packCount = 0;
  #reuseCount = 0;

  getTarball(outDirectory: string): CachedPackedTarball | undefined {
    return this.#tarballs.get(normalizeAbsolutePath(outDirectory));
  }

  recordTarball(
    outDirectory: string,
    tarball: Buffer,
    tarballName = 'package.tgz',
  ): CachedPackedTarball {
    const normalized = normalizeAbsolutePath(outDirectory);
    const entry: CachedPackedTarball = Object.freeze({
      digest: createHash('sha256').update(tarball).digest('hex'),
      outDir: normalized,
      tarball: Buffer.from(tarball),
      tarballName,
    });
    this.#tarballs.set(normalized, entry);
    return entry;
  }

  async getOrPackTarball(
    outDirectory: string,
    pack: () => Promise<{ tarball: Buffer; tarballName: string }>,
  ): Promise<CachedPackedTarball> {
    const normalized = normalizeAbsolutePath(outDirectory);
    const cached = this.#tarballs.get(normalized);
    if (cached !== undefined) {
      this.#reuseCount += 1;
      return cached;
    }
    const existing = this.#inFlight.get(normalized);
    if (existing !== undefined) {
      this.#reuseCount += 1;
      return existing;
    }
    const promise = (async () => {
      this.#packCount += 1;
      const packed = await pack();
      return this.recordTarball(normalized, packed.tarball, packed.tarballName);
    })();
    this.#inFlight.set(normalized, promise);
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(normalized);
    }
  }

  getStats(): Readonly<{ packCount: number; reuseCount: number }> {
    return {
      packCount: this.#packCount,
      reuseCount: this.#reuseCount,
    };
  }

  dispose(): void {
    this.#inFlight.clear();
    this.#tarballs.clear();
  }
}
