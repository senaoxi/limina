import type { VueProjectSemanticIdentity } from '#checkers';
import type { DeclarationLoadingPlan } from '../../domain/analysis/declaration-governance';
import { shareVueExecutionInputs } from '../analysis-cache/vue-execution-inputs';
import { nativeFingerprint } from '../typescript-semantic/native-file-identity';

export function withVueDeclarationLoading(
  identity: VueProjectSemanticIdentity,
  declarationLoading: DeclarationLoadingPlan,
): VueProjectSemanticIdentity {
  const declarationBaseId = identity.declarationBaseId ?? identity.id;
  const id = nativeFingerprint([declarationBaseId, declarationLoading]);
  if (id === identity.id) return identity;
  const scoped = { ...identity, declarationBaseId, declarationLoading, id };
  shareVueExecutionInputs(identity, scoped);
  return scoped;
}
