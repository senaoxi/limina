import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeActivation } from './activation.ts';
import type { Snapshot } from './snapshot.ts';

test('native visibility, attempted reading and observed complete reading have separate evidence', () => {
  const skill = {
    entries: [
      {
        kind: 'file',
        path: 'SKILL.md',
        content: Buffer.from('Follow protected project boundaries.').toString(
          'base64',
        ),
      },
      {
        kind: 'file',
        path: 'references/topic.md',
        content: Buffer.from('Inspect the actual consumer.').toString('base64'),
      },
    ],
  } as Snapshot;
  const evidence = [
    { kind: 'trace' as const, path: 'trace.json', sha256: 'a'.repeat(64) },
  ];
  const make = (
    exit: number,
    output: string,
    command = 'cat .agents/skills/limina/SKILL.md',
  ): Snapshot => {
    const prefix = 'session/';
    const events = [
      {
        type: 'tool_call_started',
        tool_call_id: 'one',
        invocation_payload: { path: 'payloads/1.json' },
      },
      {
        type: 'tool_call_ended',
        tool_call_id: 'one',
        status: 'completed',
        result_payload: { path: 'payloads/2.json' },
      },
    ];
    const files = {
      'trace.jsonl': `${events.map((payload) => JSON.stringify({ payload })).join('\n')}\n`,
      'payloads/1.json': JSON.stringify({
        tool_name: 'exec_command',
        payload: {
          type: 'function',
          arguments: JSON.stringify({
            cmd: command,
          }),
        },
      }),
      'payloads/2.json': JSON.stringify({ value: { exit_code: exit, output } }),
    };
    return {
      entries: Object.entries(files).map(([file, content]) => ({
        kind: 'file',
        path: prefix + file,
        content: Buffer.from(content).toString('base64'),
      })),
    } as Snapshot;
  };
  const unseen = observeActivation({
    skill,
    discoverable: true,
    trace: make(0, 'path mentioned only'),
    traceComplete: true,
    evidence,
  });
  assert.equal(unseen.discoverable.state, 'yes');
  assert.equal(unseen.discovered.state, 'unknown');
  const read = observeActivation({
    skill,
    discoverable: true,
    trace: make(0, 'Follow protected project boundaries.'),
    traceComplete: true,
    evidence,
  });
  assert.equal(read.skillRead.state, 'yes');
  assert.equal(read.followed.state, 'unknown');
  assert.equal(read.referenceReads['references/topic.md']!.state, 'unknown');
  const failed = observeActivation({
    skill,
    discoverable: true,
    trace: make(1, 'Follow protected project boundaries.'),
    traceComplete: true,
    evidence,
  });
  assert.equal(failed.skillRead.state, 'unknown');
  const mentioned = observeActivation({
    skill,
    discoverable: true,
    trace: make(
      0,
      'Follow protected project boundaries.',
      'cat unrelated; echo text # .agents/skills/limina/SKILL.md',
    ),
    traceComplete: true,
    evidence,
  });
  assert.equal(mentioned.skillRead.state, 'unknown');
  const partial = observeActivation({
    skill,
    discoverable: true,
    trace: make(0, 'Follow protected project boundaries.'),
    traceComplete: false,
    evidence,
  });
  assert.equal(partial.skillRead.state, 'unknown');
  const base = observeActivation({
    skill: null,
    discoverable: false,
    trace: make(0, ''),
    traceComplete: true,
    evidence,
  });
  assert.equal(base.installed.state, 'no');
  assert.equal(base.skillRead.state, 'no');
});
