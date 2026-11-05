import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { processGroupHasWriters, terminateProcessTree } from '../acquisition-process.mjs';

test('termination is idempotent and force-stops a TERM-ignoring group', async t => {
  const child = spawn('/bin/sh', ['-c', "trap '' TERM; printf ready; while :; do sleep 1; done"],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => { await terminateProcessTree(child, { graceMs: 100 }); await closed; });
  await once(child.stdout, 'data');
  assert.equal(await processGroupHasWriters(child.pid), true);
  const stopping = terminateProcessTree(child, { graceMs: 100 });
  assert.strictEqual(terminateProcessTree(child), stopping);
  await stopping;
  assert.equal(await processGroupHasWriters(child.pid), false);
});

test('leader close cannot release a descendant which has closed its stdio', async t => {
  const child = spawn('/bin/sh', ['-c',
    "(trap '' TERM; exec </dev/null >/dev/null 2>&1; while :; do sleep 1; done) & printf ready; exit 0"],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(() => terminateProcessTree(child, { graceMs: 100 }));
  await closed;
  assert.equal(child.exitCode, 0);
  assert.equal(await processGroupHasWriters(child.pid), true, 'the descendant can still write after leader close');
  await terminateProcessTree(child, { graceMs: 100 });
  assert.equal(await processGroupHasWriters(child.pid), false);
});
