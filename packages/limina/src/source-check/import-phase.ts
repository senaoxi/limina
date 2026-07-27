import { addImportAuthorityOwnerConfigProblems } from './import-authority-config-findings';
import {
  addImportAuthorityRootManifestConfigProblems,
  collectImportAuthorityAllowRules,
  getSourceOwnerIdentity,
} from './import-authority-grants';
import type { SourceCheckState } from './run-state';
import { addSourceImportProblems } from './source-import-validation';

type SourceImportAuthorityPhaseInput = Readonly<
  Pick<
    SourceCheckState,
    | 'ambientDeclarations'
    | 'checkItems'
    | 'checks'
    | 'config'
    | 'core'
    | 'findings'
    | 'packageOwners'
    | 'packages'
    | 'preflight'
    | 'rootPackage'
    | 'sourceProjectEntries'
    | 'workspaceLookup'
    | 'workspacePathIndex'
  >
>;

function collectOwnerIdentities(
  state: SourceImportAuthorityPhaseInput,
): Set<string> {
  return new Set(
    state.packageOwners.map((owner) =>
      getSourceOwnerIdentity({ config: state.config, owner }),
    ),
  );
}

export async function runSourceImportAuthorityPhase(
  state: SourceImportAuthorityPhaseInput,
): Promise<void> {
  state.checkItems.start('source import authority');
  const importAuthorityAllowRules = collectImportAuthorityAllowRules({
    checks: state.checks,
    config: state.config,
    findings: state.findings,
  });

  addImportAuthorityOwnerConfigProblems({
    checks: state.checks,
    config: state.config,
    findings: state.findings,
    ownerIdentities: collectOwnerIdentities(state),
  });
  addImportAuthorityRootManifestConfigProblems({
    checks: state.checks,
    config: state.config,
    findings: state.findings,
    importAuthorityAllowRules,
  });
  addSourceImportProblems({
    ambientDeclarations: state.ambientDeclarations.index,
    checks: state.checks,
    config: state.config,
    importAnalysis: state.preflight.importAnalysis,
    importAuthorityAllowRules,
    packages: state.packages,
    pathIndex: state.workspacePathIndex,
    findings: state.findings,
    rootPackage: state.rootPackage,
    sourceProjectEntries: state.sourceProjectEntries,
    typeEvidence: state.core.typeEvidence,
    workspaceLookup: state.workspaceLookup,
  });
  state.checkItems.record('source import authority');
}
