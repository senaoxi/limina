import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { campaignFixture } from '../core/campaign.test-helper.ts';
import { createModelProfile } from '../core/model-profile.ts';
import { sha256 } from '../core/snapshot.ts';
import {
  codexEnvironment,
  inspectAccount,
  localCodexArguments,
} from '../runner/local-codex.ts';

test('profile overrides reach native invocation and paginated account discovery without fallback', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'eval-model-discovery-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'codex');
  const helper = 'synthetic helper identity';
  const source = `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0)}\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{const q=JSON.parse(l);if(!q.id)return;let result={};switch(q.method){case 'account/read':result={account:{type:'chatgpt',planType:'pro'}};break;case 'account/rateLimits/read':result={ordinaryUsageAllowed:true,rateLimits:{credits:{balance:'0',hasCredits:false,unlimited:false},spendControlReached:false}};break;case 'model/list':result=q.params.cursor?{data:[{model:'model-two',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null}:{data:[{model:'model-one',supportedReasoningEfforts:[{reasoningEffort:'low'}]}],nextCursor:'page2'};break;case 'skills/list':result={data:[{errors:[],skills:[]}]};break;}console.log(JSON.stringify({id:q.id,result}))});\n`;
  await writeFile(executable, source);
  await chmod(executable, 0o700);
  await writeFile(path.join(root, 'codex-code-mode-host'), helper);
  const identity = {
    executable,
    version: '0.166.0' as const,
    sha256: sha256(source),
    codeModeHostSha256: sha256(helper),
  };
  const { profiles } = campaignFixture();
  const {
    id: _id,
    version: _v,
    ...input
  } = profiles.find((p) => p.canonicalModelId === 'model-two')!;
  const profile = createModelProfile({
    ...input,
    codex: {
      version: identity.version,
      sha256: identity.sha256,
      codeModeHostSha256: identity.codeModeHostSha256,
    },
  });
  const argv = localCodexArguments('/workspace', [], [], profile);
  assert.ok(argv.includes('model="model-two"'));
  assert.ok(argv.includes('model_context_window=272000'));
  assert.ok(!argv.includes('model="gpt-6.1-terra"'));
  const observed = await inspectAccount(
    identity,
    codexEnvironment(root, root, [path.dirname(process.execPath)], root),
    { workspace: root, disabledSkillPaths: [] },
    profile,
  );
  assert.equal(observed.model?.model, 'model-two');
  assert.deepEqual(observed.skills, []);
  const absent = createModelProfile({
    ...input,
    canonicalModelId: 'absent-model',
    codex: profile.codex,
  });
  const unavailable = await inspectAccount(
    identity,
    codexEnvironment(root, root, [path.dirname(process.execPath)], root),
    undefined,
    absent,
  );
  assert.equal(unavailable.model, null);
});
