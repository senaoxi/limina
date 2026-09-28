import { describe, expect, it } from 'vitest';

import {
  isLiminaArtifactPath,
  isOrdinarySourceTypecheckConfigPath,
} from '../core/tsconfig/actions';

const nestedWorkspaceRoot =
  '/workspace/.limina/integration/limina-integration-fixture/repo';

describe('workspace-relative Limina artifact paths', () => {
  it('does not treat an ancestor .limina directory as the workspace artifact namespace', () => {
    const sourceConfigPath = `${nestedWorkspaceRoot}/tsconfig.json`;

    expect(isLiminaArtifactPath(sourceConfigPath, nestedWorkspaceRoot)).toBe(
      false,
    );
    expect(
      isOrdinarySourceTypecheckConfigPath(
        sourceConfigPath,
        nestedWorkspaceRoot,
      ),
    ).toBe(true);
  });

  it('still rejects configs inside the nested workspace artifact namespace', () => {
    const generatedConfigPath = `${nestedWorkspaceRoot}/.limina/tsconfig/generated.json`;

    expect(isLiminaArtifactPath(generatedConfigPath, nestedWorkspaceRoot)).toBe(
      true,
    );
    expect(
      isOrdinarySourceTypecheckConfigPath(
        generatedConfigPath,
        nestedWorkspaceRoot,
      ),
    ).toBe(false);
  });

  it('keeps sibling external source configs eligible', () => {
    const externalConfigPath =
      '/workspace/.limina/integration/limina-integration-fixture/external/shared/tsconfig.json';

    expect(
      isOrdinarySourceTypecheckConfigPath(
        externalConfigPath,
        nestedWorkspaceRoot,
      ),
    ).toBe(true);
  });
});
