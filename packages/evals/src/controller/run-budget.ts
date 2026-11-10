import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BudgetManager } from '../core/budget.ts';
import type { RunStore } from '../core/run-store.ts';
import { sha256 } from '../core/snapshot.ts';

interface Anchor {
  experiment: string;
  ledger: string;
  prefixBytes: number;
  prefixSha256: string;
}
export async function bindRunBudget(store: RunStore, ledger: string) {
  if ((await realpath(ledger)) !== ledger)
    throw new Error('Budget ledger must be canonical');
  const bytes = await readFile(ledger);
  const anchor: Anchor = {
    experiment: store.manifest.identity,
    ledger,
    prefixBytes: bytes.length,
    prefixSha256: sha256(bytes),
  };
  try {
    await writeFile(
      path.join(store.directory, 'budget-anchor.json'),
      `${JSON.stringify(anchor)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await verifyBudgetSource(store, ledger);
}
export async function verifyBudgetSource(
  store: RunStore,
  ledger: string,
  snapshot?: Uint8Array,
): Promise<{ budget: ReturnType<BudgetManager['summary']>; digest: string }> {
  const anchorFile = path.join(store.directory, 'budget-anchor.json');
  if (
    (await realpath(anchorFile)) !== anchorFile ||
    (!snapshot && (await realpath(ledger)) !== ledger)
  )
    throw new Error('Aliased budget evidence');
  const anchor: Anchor = JSON.parse(await readFile(anchorFile, 'utf8'));
  const bytes = snapshot ? Buffer.from(snapshot) : await readFile(ledger);
  if (
    anchor.experiment !== store.manifest.identity ||
    anchor.ledger !== ledger ||
    !Number.isSafeInteger(anchor.prefixBytes) ||
    anchor.prefixBytes < 0 ||
    bytes.length < anchor.prefixBytes ||
    sha256(bytes.subarray(0, anchor.prefixBytes)) !== anchor.prefixSha256
  )
    throw new Error('Budget source changed or ledger history was lost');
  const budget = BudgetManager.readSnapshot(ledger, bytes);
  // buildReport reconciles attempt token evidence while allowing later settlement.
  const digest = sha256(bytes);
  if (!snapshot && sha256(await readFile(ledger)) !== digest)
    throw new Error('Budget ledger changed during reconciliation');
  return { budget, digest };
}
