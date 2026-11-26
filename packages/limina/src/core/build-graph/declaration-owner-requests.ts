import { compareCodeUnits } from '#utils/collections';
import type { DeclarationContextReceipt } from '../../domain/analysis/declaration-context';
import type { DeclarationCompilationEvidence } from '../../domain/analysis/declaration-governance';
import { DeclarationObservationUnavailable } from '../declaration-governance/candidate';

type Origin = DeclarationCompilationEvidence['requestOrigins'][number];

/** Compare the selected source Checker with its own generated config. The
 * consumer-to-owner comparison additionally proves actual delegation. */
export function validateOwnerDeclarationRequests(
  receipt: DeclarationContextReceipt,
  evidence: readonly DeclarationCompilationEvidence[],
  fileKey: (file: string) => string,
): void {
  const files = new Set(
    receipt.mappings
      .filter((mapping) => mapping.referenceConfig === receipt.generatedConfig)
      .map((mapping) => fileKey(mapping.file)),
  );
  if (files.size === 0) return;
  const source = evidence.find(
    (item) =>
      item.sourceConfig === receipt.sourceConfig &&
      item.authority.checker === receipt.checker,
  );
  if (!source || source.completeness !== 'complete')
    throw new DeclarationObservationUnavailable(
      `Missing selected declaration request inventory: ${receipt.sourceConfig}`,
    );
  const signature = (
    file: string,
    specifier: string,
    binding: NonNullable<Origin['binding']>,
  ) =>
    JSON.stringify([
      fileKey(file),
      specifier,
      binding.position,
      binding.channel,
      binding.mode,
      binding.resolutionState,
      binding.target === null ? null : fileKey(binding.target),
    ]);
  const expected = source.requestOrigins
    .flatMap((item) =>
      item.binding && files.has(fileKey(item.file))
        ? [signature(item.file, item.specifier, item.binding)]
        : [],
    )
    .sort(compareCodeUnits);
  const observed = receipt.requests
    .filter((item) => item.channel !== 'root' && files.has(fileKey(item.file)))
    .map((item) =>
      signature(
        item.file,
        item.specifier,
        item.referencedPathInput === undefined
          ? item
          : {
              ...item,
              target: item.referencedPathInput,
              resolutionState: 'resolved',
            },
      ),
    )
    .sort(compareCodeUnits);
  if (
    expected.length !== observed.length ||
    expected.some((item, index) => item !== observed[index])
  )
    throw new DeclarationObservationUnavailable(
      `Generated declaration requests differ from their selected source context: ${receipt.sourceConfig}`,
    );
}
