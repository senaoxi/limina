import {
  isBarePackageSpecifier,
  isPackageImportSpecifier,
} from '#utils/module-specifier';
import type {
  DependencyAnalysisResult,
  ReferencePackageRequest,
} from './types';

export function recordReferencePackageRequest(
  analysis: DependencyAnalysisResult | undefined,
  request: ReferencePackageRequest,
  channel: string | undefined,
): void {
  if (
    analysis === undefined ||
    channel === 'path-directive' ||
    channel === 'triple-slash-path'
  )
    return;
  if (
    isBarePackageSpecifier(request.specifier) ||
    isPackageImportSpecifier(request.specifier)
  ) {
    (analysis.packageRequests ??= []).push(request);
  }
}
