import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invariant, positiveInteger, requiredEnvironment } from './io.ts';
import type { ApiArtifact, ApiJob, ApiRun } from './types.ts';

/**
Read-only, deadline-bounded access. Never send credentials to artifact redirects.
*/
export class GitHub {
  private records = new Set<number>();
  private cache = new Map<string, unknown>();
  readonly repository: string;
  readonly deadline: number;
  readonly token: string;
  readonly api: string;
  constructor(
    repo = requiredEnvironment('GITHUB_REPOSITORY'),
    budget = 60_000,
  ) {
    invariant(/^[\w.-]+\/[\w.-]+$/.test(repo), 'Invalid repository');
    this.repository = repo;
    this.deadline = Date.now() + budget;
    this.token = requiredEnvironment('GH_TOKEN');
    this.api = process.env.GITHUB_API_URL || 'https://api.github.com';
    invariant(this.api === 'https://api.github.com', 'Unsupported API origin');
  }
  remaining(): number {
    const remaining = this.deadline - Date.now();
    invariant(remaining > 0, 'GitHub evidence budget exhausted');
    return remaining;
  }
  async response(
    endpoint: string,
    redirect: 'follow' | 'manual' = 'follow',
  ): Promise<Response> {
    invariant(
      endpoint.startsWith('/repos/' + this.repository + '/') &&
        !endpoint.includes('..'),
      'Invalid API endpoint',
    );
    const response = await fetch(this.api + endpoint, {
      headers: {
        Authorization: 'Bearer ' + this.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect,
      signal: AbortSignal.timeout(this.remaining()),
    });
    invariant(
      response.ok || response.status === 302,
      'GitHub read failed: ' + response.status,
    );
    return response;
  }
  async get<T>(suffix: string): Promise<T> {
    this.remaining();
    if (!this.cache.has(suffix))
      this.cache.set(
        suffix,
        await (
          await this.response('/repos/' + this.repository + suffix)
        ).json(),
      );
    return this.cache.get(suffix) as T;
  }
  async pages<T>(suffix: string, key: string, maximum = 1000): Promise<T[]> {
    const result: T[] = [];
    let expectedCount: number | undefined;
    for (let page = 1; ; page++) {
      const data = await this.get<Record<string, unknown>>(
        suffix +
          (suffix.includes('?') ? '&' : '?') +
          'per_page=100&page=' +
          page,
      );
      invariant(
        Number.isSafeInteger(data.total_count) &&
          Number(data.total_count) < maximum,
        'Incomplete API history or pagination limit',
      );
      expectedCount ??= Number(data.total_count);
      invariant(
        expectedCount === data.total_count,
        'API pagination changed during traversal',
      );
      const items = data[key];
      invariant(Array.isArray(items), 'Invalid paginated response');
      result.push(...(items as T[]));
      invariant(result.length <= maximum, 'API record budget exceeded');
      invariant(result.length <= expectedCount, 'Overlapping API pages');
      if (result.length === expectedCount) break;
      invariant(items.length > 0, 'Truncated API page');
    }
    const ids = result.map((item) => (item as { id: unknown }).id);
    invariant(new Set(ids).size === ids.length, 'Duplicate API records');
    return result;
  }
  async runs(query: Record<string, string>): Promise<ApiRun[]> {
    const runs = await this.pages<ApiRun>(
      '/actions/workflows/ci.yml/runs?' +
        new URLSearchParams({ event: 'push', branch: 'main', ...query }),
      'workflow_runs',
    );
    for (const run of runs) this.records.add(run.id);
    invariant(this.records.size <= 1000, 'Resolver Run budget exceeded');
    return runs;
  }
  run(id: number): Promise<ApiRun> {
    return this.get('/actions/runs/' + positiveInteger(id, 'Run ID'));
  }
  jobs(id: number, attempt: number): Promise<ApiJob[]> {
    return this.pages(
      `/actions/runs/${positiveInteger(id, 'Run ID')}/attempts/${positiveInteger(attempt, 'attempt')}/jobs`,
      'jobs',
    );
  }
  artifacts(id: number): Promise<ApiArtifact[]> {
    return this.pages(
      `/actions/runs/${positiveInteger(id, 'Run ID')}/artifacts`,
      'artifacts',
      4000,
    );
  }
  async jsonArtifact<T>(
    artifact: ApiArtifact,
    filename: 'plan.json' | 'audit.json' | 'receipt.json',
  ): Promise<T> {
    invariant(!artifact.expired, 'Expired evidence artifact');
    const response = await this.response(
      `/repos/${this.repository}/actions/artifacts/${positiveInteger(artifact.id, 'Artifact ID')}/zip`,
      'manual',
    );
    invariant(response.status === 302, 'Expected artifact redirect');
    const location = response.headers.get('location');
    invariant(
      location && new URL(location).protocol === 'https:',
      'Invalid artifact location',
    );
    const download = await fetch(location, {
      signal: AbortSignal.timeout(this.remaining()),
    });
    invariant(
      download.ok &&
        Number(download.headers.get('content-length') || 0) <= 16 * 1024 * 1024,
      'Artifact download failed or too large',
    );
    const reader = download.body?.getReader();
    invariant(reader, 'Missing artifact body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Artifact size limit');
      }
      chunks.push(value);
    }
    const directory = mkdtempSync(
      path.join(os.tmpdir(), 'limina-ci-evidence-'),
    );
    try {
      const zip = path.join(directory, 'evidence.zip');
      writeFileSync(zip, Buffer.concat(chunks));
      const entries = execFileSync('unzip', ['-Z1', zip], {
        timeout: this.remaining(),
        maxBuffer: 1024 * 1024,
      })
        .toString('utf8')
        .split('\n')
        .filter(Boolean);
      invariant(
        entries.length === 1 && entries[0] === filename,
        'Unexpected evidence archive inventory',
      );
      const content = execFileSync('unzip', ['-p', zip, filename], {
        timeout: this.remaining(),
        maxBuffer: 16 * 1024 * 1024,
      });
      return JSON.parse(content.toString('utf8')) as T;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
export function oneArtifact(
  artifacts: ApiArtifact[],
  name: string,
): ApiArtifact {
  const matches = artifacts.filter(
    (artifact) => artifact.name === name && !artifact.expired,
  );
  invariant(matches.length === 1, 'Missing or ambiguous artifact: ' + name);
  return matches[0]!;
}
