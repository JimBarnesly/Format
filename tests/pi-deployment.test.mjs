import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('Pi read-only mode blocks media mutation and background acquisition without relaxing publication', async () => {
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /const corrections = readOnly \? \[\] : await applyMetadataCorrections\(paths\)/);
  assert.match(server, /function processAcquisitionQueue\(\) \{\s+if \(shuttingDown\) return;\s+if \(\(readOnly && !downloadOnly\) \|\| acquisitionShutdownUncertain\) return;/);
  assert.match(server, /const shadowRepairEnabled = !readOnly/);
  assert.match(server, /server.listen\(port, host/);
  assert.match(server, /readOnly && !\["GET", "HEAD"\]/);
  assert.match(server, /"\/api\/rescan", "\/api\/shadow-albums\/reconcile"/);
  assert.match(server, /async function performLibraryScan\(\) \{\s+await verifyMusicMount\(\)/);
});

test('Pi deployment unit and filesystem guard tests', () => {
  execFileSync('python3', ['-m', 'unittest', 'discover', '-s', 'deployment/pi', '-p', 'test_*.py'], { stdio: 'pipe' });
});

test('read-only server scans without retagging, rejects mutations, and retains production publication rules', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:net');
  const { spawn } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const temporary = await mkdtemp(join(tmpdir(), 'format-readonly-'));
  let child;
  try {
    const music = join(temporary, 'music');
    const data = join(temporary, 'data');
    await mkdir(music); await mkdir(data);
    const audio = join(music, 'source.flac');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.1',
      '-metadata', 'artist=Fixture', '-metadata', 'album=Fixture', '-metadata', 'title=Original',
      '-metadata', 'track=1/1', audio]);
    const original = await readFile(audio);
    const corrections = join(temporary, 'corrections.json');
    await writeFile(corrections, JSON.stringify({ corrections: [{sha256: createHash('sha256').update(original).digest('hex'),
      sourceRelativePath: 'source.flac', relativePath: 'rewritten.flac', title: 'Changed'}] }));
    await writeFile(join(data, 'acquisitions.json'), JSON.stringify({items: [{id: 'pending', status: 'queued', artist: 'Fixture', title: 'Fixture', release: {id:'pending', artist:'Fixture',title:'Fixture'}}]}));
    const port = await new Promise((resolve, reject) => {
      const server = createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {const p = server.address().port; server.close(() => resolve(p));});
    });
    child = spawn(process.execPath, ['server.mjs'], {cwd: new URL('..', import.meta.url),
      env: {...process.env, NODE_ENV:'production', FORMAT_READ_ONLY:'true', HOST:'127.0.0.1', PORT:String(port),
        MUSIC_ROOT:music, DATA_DIR:data, CACHE_DIR:join(temporary,'cache'), METADATA_CORRECTIONS_FILE:corrections},
      stdio:'ignore'});
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i=0;i<100;i++) {
      try { ready = (await (await fetch(base+'/api/health')).json()).initialLibraryScanComplete; } catch {}
      if (ready) break;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.ok(ready, 'server finished scanning');
    const health = await (await fetch(base+'/api/health')).json();
    assert.equal(health.readOnly, true);
    assert.deepEqual(health.downloads, {enabled:false,ready:false,reason:'disabled'});
    assert.deepEqual(health.capabilities, {acquire:false,cancel:false,prioritize:false,editMetadata:false,deleteMedia:false,repair:false});
    assert.deepEqual(await readFile(audio), original);
    const library = await (await fetch(base+'/api/library')).json();
    assert.equal(library.albums.length, 0, 'production policy does not silently publish unverified albums');
    for (const [path, method] of [['/api/library/trash-track','POST'],['/api/library/album-metadata','PUT'],['/api/acquire-album','POST'],['/api/acquisitions/history','DELETE']]) {
      assert.equal((await fetch(base+path, {method})).status,403);
    }
    assert.equal((await fetch(base+'/api/rescan', {method:'POST'})).status,200);
    const queue = await (await fetch(base+'/api/acquisitions')).json();
    assert.equal(queue[0].status, 'queued', 'restored downloader stays idle');
    assert.deepEqual(await readFile(audio), original);
  } finally {
    if(child) { child.kill(); await new Promise(resolve => child.once('close', resolve)); }
    await rm(temporary,{recursive:true,force:true});
  }
});
