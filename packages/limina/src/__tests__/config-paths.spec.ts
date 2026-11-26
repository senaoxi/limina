import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseTypeScriptCommandLine } from '../checker/project-base';
import { emptyMetrics } from '../core/analysis-cache/cache-metrics';
import { AnalysisInputDriftError } from '../core/analysis-cache/contracts';
import { EpochInputs } from '../core/analysis-cache/epoch-inputs';
import { InvocationConfigReads } from '../core/analysis-cache/invocation-config-reads';
import {
  isLiminaArtifactPath,
  isOrdinarySourceTypecheckConfigPath,
} from '../core/tsconfig/actions';
import {
  readJsonConfigFile,
  TsconfigInputError,
} from '../core/tsconfig/config-paths';
import { createFixturePathResolver } from './helpers/path';

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

describe('observed raw source config', () => {
  it('uses one original JSONC input for independent raw and compiler projections', async () => {
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'limina-raw-'));
    const rootDirectory = realpathSync.native(temporaryDirectory);
    const fixturePath = createFixturePathResolver(rootDirectory);
    const configPath = fixturePath('tsconfig.json');
    const reads = new InvocationConfigReads(emptyMetrics());
    const inputs = new EpochInputs();
    try {
      writeFileSync(
        fixturePath('base.json'),
        '{"include":["*.ts"],"compilerOptions":{"strict":true}}',
      );
      writeFileSync(fixturePath('index.ts'), 'export {}');
      writeFileSync(configPath, '{\n// leaf only\n"extends":"./base.json",\n}');
      const raw = () => readJsonConfigFile(rootDirectory, configPath);
      const parse = () =>
        parseTypeScriptCommandLine({
          parseOptions: { configPath, projectRootDir: rootDirectory },
        });
      reads.run(() =>
        inputs.run(() => {
          const first = raw();
          expect(first).toEqual({ extends: './base.json' });
          first.include = ['untrusted.ts'];
          writeFileSync(configPath, '{"include":["missing.ts"]}');
          const result = parse();
          expect(result.parsed.options.strict).toBe(true);
          expect(result.parsed.options.configFile).toMatchObject({
            fileName: configPath,
          });
          expect(result.parsed.fileNames).toEqual([fixturePath('index.ts')]);
          expect(raw()).toEqual({ extends: './base.json' });
        }),
      );
      await expect(inputs.assertStable()).rejects.toThrow(configPath);
      expect(() => reads.run(() => inputs.run(parse))).toThrow(
        AnalysisInputDriftError,
      );
      expect(reads.run(raw)).toEqual({ include: ['missing.ts'] });
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it('binds the overlay view and retains TypeScript JSONC syntax diagnostics', async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), 'limina-overlay-'),
    );
    const rootDirectory = realpathSync.native(temporaryDirectory);
    const fixturePath = createFixturePathResolver(rootDirectory);
    const configPath = fixturePath('tsconfig.json');
    const reads = new InvocationConfigReads(emptyMetrics());
    const inputs = new EpochInputs();
    const virtualFiles = new Map([
      [configPath, '{"compilerOptions":{"target":"ES2022"},}'],
    ]);
    try {
      writeFileSync(configPath, '{"compilerOptions":{"target":"ES2020"}}');
      const raw = () =>
        readJsonConfigFile(rootDirectory, configPath, virtualFiles);
      reads.run(() =>
        inputs.run(() => {
          expect(raw()).toEqual({ compilerOptions: { target: 'ES2022' } });
          expect(
            parseTypeScriptCommandLine({
              parseOptions: {
                allowNoInputDiagnostics: true,
                configPath,
                projectRootDir: rootDirectory,
                virtualFiles,
              },
            }).parsed.options.target,
          ).toBe(ts.ScriptTarget.ES2022);
        }),
      );
      virtualFiles.set(configPath, '{"compilerOptions":');
      await expect(inputs.assertStable()).rejects.toThrow(configPath);
      expect(() => reads.run(raw)).toThrow(TsconfigInputError);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });
});
