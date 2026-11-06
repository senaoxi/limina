import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadConfig } from '../../src/config/loader.ts';
import { createLiminaArtifactNamespace } from '../../src/domain/artifacts/namespace.ts';
import { AnalysisCacheController } from '../../src/preflight/analysis-cache.ts';
import { observeAnalysisRead } from '../../src/utils/analysis-input.ts';

assert.ok(process.argv[2], 'provide a fresh output directory');
const root = path.resolve(process.argv[2]);
mkdirSync(root);
writeFileSync(
  path.join(root, 'package.json'),
  '{"name":"epoch-replay","private":true}',
);
const configPath = path.join(root, 'limina.config.mjs');
writeFileSync(configPath, 'export default {};');
const config = await loadConfig({ cwd: root, configPath });
const observations = [];
for (const timing of ['before-identity', 'during-validation']) {
  const controller = new AnalysisCacheController(
    config,
    createLiminaArtifactNamespace({ rootDir: root, generation: 0 }),
    { canPublish: false },
  );
  const captured = controller.cache;
  const enter = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const result = controller.analyze({
    refresh: () => controller.refresh(),
    analyze: async () => {
      observeAnalysisRead({
        key: 'barrier',
        path: configPath,
        value: 'same',
        read: async () => {
          enter.resolve();
          await resume.promise;
          return 'same';
        },
      });
      return captured;
    },
  });
  if (timing === 'before-identity') {
    const rejected = assert.rejects(result, /epoch was replaced/);
    controller.refresh();
    resume.resolve();
    await rejected;
    observations.push({ timing, result: 'rejected' });
  } else {
    await enter.promise;
    controller.refresh();
    resume.resolve();
    assert.equal(await result, captured);
    assert.notEqual(captured, controller.cache);
    observations.push({ timing, result: 'returned detached epoch' });
  }
}
writeFileSync(
  path.join(root, 'observations.json'),
  `${JSON.stringify(observations, null, 2)}\n`,
);
