import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquisitionMarker } from '../download-policy.mjs';
import { processGroupHasWriters } from '../acquisition-process.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,check,label) {
  for(let i=0;i<240;i++) { const value=await read(); if(check(value)) return value; await pause(50); }
  assert.fail(label);
}

async function startFixture(t,{enabled=true,env={},jobs=[],initialDisk="fixture-disk"}={}) {
  const temporary=await mkdtemp(join(tmpdir(),'format-protected-download-'));
  const root=join(temporary,'music'), data=join(temporary,'data'), acquisition=join(root,'Acquisitions');
  const albums=join(acquisition,'albums'), staging=join(acquisition,'staging'), bin=join(temporary,'bin');
  await mkdir(albums,{recursive:true}); await mkdir(staging); await mkdir(data); await mkdir(bin);
  await writeFile(join(acquisition,acquisitionMarker),JSON.stringify({schemaVersion:1,filesystemUuid:'fixture-disk'}));
  const disk=join(temporary,'disk-uuid'); await writeFile(disk,initialDisk);
  await writeFile(join(bin,'findmnt'),`#!/bin/sh\nprintf '{"filesystems":[{"uuid":"%s","target":"/fixture-hdd"}]}\\n' "$(cat "$FIXTURE_DISK")"\n`,{mode:0o755});
  const titles=['Good Album','Slow Album','First Queue','Priority Queue','Cancel Queue','Bad Manifest','Linked Album','Lost Disk','Resume Album','Lookup Cancel','Validate Cancel','Term Resistant'];
  const releases=titles.map((title,i)=>({id:`fixture-${i}`,title,artist:'Fixture Artist',year:'2024'}));
  const original=join(root,'original.flac');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.1',
    '-metadata','artist=Original Artist','-metadata','album=Original Album','-metadata','title=Original Track','-metadata','track=1',original]);
  const originalBytes=await readFile(original);
  const fixtures=join(temporary,'fixtures'); await mkdir(fixtures);
  for(const release of releases) {
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.1',
      '-metadata',`artist=${release.artist}`,'-metadata',`album=${release.title}`,'-metadata','title=Fixture Track',
      '-metadata','track=1','-metadata','tracktotal=1',join(fixtures,`${release.id}.flac`)]);
  }
  await writeFile(join(data,'discovery.json'),JSON.stringify(releases.map(release=>({...release,status:'pending'}))));
  await writeFile(join(data,'acquisitions.json'),JSON.stringify({items:jobs}));
  const log=join(temporary,'downloader-log');
  const pidFile=join(temporary,'downloader-pid');
  const downloader=join(bin,'mock-downloader');
  await writeFile(downloader,`#!/bin/sh\nset -eu\necho "$$" > "$FIXTURE_PID"\nid="\${1##*/}"\necho "$id" >> "$FIXTURE_LOG"\nout="$2/Fixture Artist/$id"\nmkdir -p "$out"\ncase "$id" in fixture-6) ln -s "$FIXTURE_ORIGINAL" "$out/track.flac" ;; *) cp "$FIXTURE_FILES/$id.flac" "$out/track.flac" ;; esac\ncase "$id" in fixture-11) trap '' TERM; echo term-resistant-ready >> "$FIXTURE_LOG"; while :; do sleep 1; done ;; fixture-1|fixture-7|fixture-8) sleep 30 ;; esac\n`,{mode:0o755});
  const metadata=join(temporary,'mock-metadata.mjs');
  await writeFile(metadata,`
    const releases=${JSON.stringify(releases)};
    const group=r=>({...r,'primary-type':'Album','secondary-types':[],'first-release-date':'2024-01-01','artist-credit':[{artist:{name:r.artist}}],relations:[{url:{resource:'https://music.apple.com/fixture/'+r.id}}]});
    globalThis.fetch=async input=>{
      const u=new URL(input);
      if(u.hostname==='www.last.fm') return new Response('');
      if(u.hostname!=='musicbrainz.org') throw new Error('Unexpected external request in offline fixture: '+u.hostname);
      if(u.pathname.endsWith('/artist')) return Response.json({artists:[{id:'fixture-artist',name:'Fixture Artist'}]});
      if(u.pathname.endsWith('/release-group')) {
        const query=u.searchParams.get('query')||'';
        if(query.includes('Lookup Cancel')) return new Response('Temporary fixture failure',{status:503});
        const matching=query?releases.filter(r=>query.includes(r.title)):releases;
        return Response.json({'release-groups':matching.map(group)});
      }
      if(u.pathname.endsWith('/release')) {
        const r=releases.find(r=>r.id===u.searchParams.get('release-group'));
        if(!r) throw new Error('Unknown fixture release');
        if(r.title==='Validate Cancel') await new Promise(resolve=>setTimeout(resolve,1000));
        return Response.json({releases:[{id:'manifest-'+r.id,title:r.title,date:'2024-01-01',country:'GB',
          'artist-credit':[{artist:{name:r.artist}}],media:[{position:1,'track-count':r.id==='fixture-5'?2:1,
            tracks:[{position:1,recording:{id:'recording-'+r.id,title:'Fixture Track'}}]}]}]});
      }
      throw new Error('Unexpected metadata path: '+u.pathname);
    };
  `);
  const corrections=join(temporary,'corrections.json');
  await writeFile(corrections,JSON.stringify({corrections:[{sha256:createHash('sha256').update(originalBytes).digest('hex'),
    sourceRelativePath:'original.flac',relativePath:'changed.flac',title:'Changed'}]}));
  let child, output='';
  const port=await new Promise(resolve=>{const socket=createServer();socket.listen(0,'127.0.0.1',()=>{const p=socket.address().port;socket.close(()=>resolve(p));});});
  const base=`http://127.0.0.1:${port}`;
  const environment={...process.env,NODE_ENV:'production',FORMAT_READ_ONLY:'true',FORMAT_DOWNLOADS_ENABLED:String(enabled),
    FORMAT_ACQUISITION_ROOT:acquisition,DOWNLOAD_ROOT:albums,DOWNLOAD_STAGING_ROOT:staging,MUSIC_FILESYSTEM_UUID:'fixture-disk',
    MUSIC_ROOT:root,DATA_DIR:data,CACHE_DIR:join(temporary,'cache'),HOST:'127.0.0.1',PORT:String(port),
    SPOTIFLAC_BIN:downloader,SPOTIFLAC_CWD:temporary,PATH:`${bin}:${process.env.PATH}`,METADATA_CORRECTIONS_FILE:corrections,
    FIXTURE_DISK:disk,FIXTURE_PID:pidFile,FIXTURE_LOG:log,FIXTURE_FILES:fixtures,FIXTURE_ORIGINAL:original,...env};
  async function start(overrides={}) {
    output=''; child=spawn(process.execPath,['--import',metadata,'server.mjs'],{cwd:new URL('..',import.meta.url),env:{...environment,...overrides},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',d=>output+=d); child.stderr.on('data',d=>output+=d);
    await until(async()=>{try{return await (await fetch(base+'/api/health')).json();}catch{return {};}},v=>initialDisk==='fixture-disk'?v.initialLibraryScanComplete:typeof v.readOnly==='boolean',`server startup failed: ${output}`);
  }
  async function stop() { if(child && child.exitCode===null) {child.kill();await new Promise(resolve=>child.once('close',resolve));} }
  t.after(async()=>{await stop();await rm(temporary,{recursive:true,force:true});});
  await start();
  const get=async path=>(await fetch(base+path)).json();
  const post=async(path,options={})=>fetch(base+path,{method:'POST',...options});
  const queue=()=>get('/api/acquisitions');
  const acquire=async id=>{const response=await post('/api/acquire-album?id='+id);assert.equal(response.status,202,JSON.stringify(await response.clone().json()));return response.json();};
  const terminal=async id=>until(queue,rows=>rows.some(r=>r.id===id&&['failed','complete','cancelled'].includes(r.status)),'job did not settle: '+id).then(rows=>rows.find(r=>r.id===id));
  const started=async id=>until(async()=>{try{return await readFile(log,'utf8');}catch{return '';}},v=>v.includes(id),'downloader did not start: '+id);
  return {temporary,root,acquisition,albums,staging,data,disk,downloader,log,base,get,post,queue,acquire,terminal,started,stop,start,
    original,originalBytes,releases,pidFile,output:()=>output};
}

test('protected production download goes through authoritative staging validation, publication, library and range audio', async t=>{
  const f=await startFixture(t);
  const health=await f.get('/api/health');
  assert.equal(health.readOnly,true);
  assert.deepEqual(health.downloads,{enabled:true,ready:true,reason:null});
  assert.deepEqual(health.capabilities,{acquire:true,cancel:true,prioritize:true,editMetadata:false,deleteMedia:false,repair:false});
  const catalogue=await f.get('/api/catalog/search?q=Fixture%20Artist');
  assert.ok(catalogue.albums.some(a=>a.id==='fixture-0'));
  await f.acquire('fixture-0');
  const result=await f.terminal('fixture-0'); assert.equal(result.status,'complete',result.message);
  const library=await f.get('/api/library'); assert.equal(library.albums.length,1); assert.equal(library.tracks.length,1);
  const track=library.tracks[0]; assert.ok(track.id.startsWith('Acquisitions/albums/'));
  const records=await f.get('/api/shadow-albums'); const album=records.find(r=>r.title==='Good Album');
  assert.equal(album.authoritative,true); assert.equal(album.published,true); assert.equal(album.expectedTrackCount,1);
  assert.equal(album.manifest[0].status,'validated'); assert.equal(album.manifest[0].localTrackId,track.id);
  const audio=await fetch(f.base+'/api/audio?id='+encodeURIComponent(track.id),{headers:{range:'bytes=0-31'}});
  assert.equal(audio.status,206); assert.deepEqual(Buffer.from(await audio.arrayBuffer()),(await readFile(join(f.root,track.id))).subarray(0,32));
  assert.deepEqual(await readdir(f.staging),[]);
  assert.deepEqual(await readFile(f.original),f.originalBytes);
  for(const [path,method] of [['/api/library/trash-track','POST'],['/api/library/trash-album','POST'],['/api/library/album-metadata','PUT'],
    ['/api/shadow-albums/acquire','POST'],['/api/discoveries/acquire-random','POST'],['/api/acquisitions/history','DELETE'],['/api/download-approvals/approve','POST']]) {
    assert.equal((await fetch(f.base+path,{method})).status,403,path);
  }
  assert.equal((await f.post('/api/acquire-album?id=fixture-1',{headers:{origin:'https://evil.invalid'}})).status,403);
  assert.equal((await f.post('/api/acquire-album?id=fixture-1',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.deepEqual(await readFile(f.original),f.originalBytes);
});

test('invalid authoritative manifest and linked staging never publish and remain excluded after disabling downloads', async t=>{
  const f=await startFixture(t);
  for(const id of ['fixture-5','fixture-6']) {
    await f.acquire(id); const result=await f.terminal(id); assert.equal(result.status,'failed');
  }
  assert.equal((await f.get('/api/library')).tracks.length,0);
  assert.deepEqual(await readdir(f.albums),[]);
  const stageId=createHash('sha256').update('fixture-5').digest('hex');
  const stagingTrack=`Acquisitions/staging/${stageId}/Fixture Artist/fixture-5/track.flac`;
  assert.equal((await fetch(f.base+'/api/audio?id='+encodeURIComponent(stagingTrack))).status,404);
  await f.stop(); await f.start({FORMAT_DOWNLOADS_ENABLED:'false',FORMAT_ACQUISITION_ROOT:'',DOWNLOAD_STAGING_ROOT:join(f.data,'other-staging')});
  assert.equal((await f.get('/api/health')).capabilities.acquire,false);
  assert.equal((await f.get('/api/library')).tracks.length,0);
  const snapshot=JSON.parse(await readFile(join(f.data,'catalogued-library-snapshot.json'),'utf8'));
  assert.ok(snapshot.library.tracks.every(track=>!track.id.includes('/staging/')));
  assert.deepEqual(await readFile(f.original),f.originalBytes);
});

test('cancel and priority retain single downloader ownership while legacy jobs remain inert', async t=>{
  const legacy={id:'legacy-running',artist:'Legacy',title:'Legacy',status:'running',origin:'automatic_repair',
    automaticRepairSuppressed:true,release:{id:'legacy-running',artist:'Legacy',title:'Legacy'}};
  const f=await startFixture(t,{jobs:[legacy]});
  let queue=await f.queue(); assert.equal(queue[0].status,'running'); assert.equal(queue[0].automaticRepairSuppressed,true);
  await f.acquire('fixture-1'); await f.started('fixture-1');
  for(const id of ['fixture-2','fixture-3','fixture-4']) await f.acquire(id);
  assert.equal((await f.post('/api/acquisitions/cancel?id=legacy-running')).status,202);
  assert.equal((await f.post('/api/acquisitions/cancel?id=fixture-4')).status,202);
  assert.equal((await f.post('/api/acquisitions/prioritize?id=fixture-3')).status,202);
  await pause(200);
  queue=await f.queue();
  assert.equal(queue.find(r=>r.id==='fixture-1').status,'running');
  assert.equal(queue.find(r=>r.id==='fixture-3').queuePosition,1);
  assert.equal(queue.find(r=>r.id==='fixture-2').queuePosition,2);
  assert.equal((await readFile(f.log,'utf8')).trim(),'fixture-1');
  assert.equal((await f.post('/api/acquisitions/cancel?id=fixture-1')).status,202);
  assert.equal((await f.terminal('fixture-1')).status,'cancelled');
  assert.equal((await f.terminal('fixture-3')).status,'complete');
  assert.equal((await f.terminal('fixture-2')).status,'complete');
  assert.deepEqual((await readFile(f.log,'utf8')).trim().split('\n'),['fixture-1','fixture-3','fixture-2']);
  assert.deepEqual(await readFile(f.original),f.originalBytes);
});

test('lost HDD fails closed, stops active downloader, preserves staging and keeps cancel available', async t=>{
  const f=await startFixture(t);
  await f.acquire('fixture-7'); await f.started('fixture-7');
  await f.acquire('fixture-2');
  await writeFile(f.disk,'wrong-disk');
  const health=await f.get('/api/health');
  assert.deepEqual(health.downloads,{enabled:true,ready:false,reason:'storage_unavailable'});
  assert.equal(health.capabilities.acquire,false); assert.equal(health.capabilities.cancel,true);
  assert.equal((await f.post('/api/acquire-album?id=fixture-0')).status,503);
  assert.equal((await f.post('/api/acquisitions/cancel?id=fixture-2')).status,202);
  const result=await f.terminal('fixture-7'); assert.equal(result.status,'failed'); assert.match(result.message,/storage became unavailable/);
  assert.deepEqual(await readdir(f.albums),[]);
  assert.deepEqual(await readFile(f.original),f.originalBytes);
  assert.equal((await readFile(f.log,'utf8')).trim(),'fixture-7');
});

test('missing downloader is truthful preflight and cannot queue or invoke an acquisition', async t=>{
  const f=await startFixture(t,{env:{FORMAT_READ_ONLY:'false'}});
  assert.equal((await f.get('/api/health')).readOnly,true,'download-only opt-in cannot disable media protection');
  await chmod(f.downloader,0o600);
  const health=await f.get('/api/health'); assert.equal(health.downloads.reason,'downloader_unavailable'); assert.equal(health.capabilities.acquire,false);
  assert.equal((await f.post('/api/acquire-album?id=fixture-0')).status,503);
  assert.deepEqual(await f.queue(),[]); await assert.rejects(access(f.log),{code:'ENOENT'});
});

test('a failed initial HDD scan recovers on explicit rescan and wakes the queue', async t=>{
  const f=await startFixture(t,{initialDisk:'wrong-disk'});
  assert.equal((await f.get('/api/health')).initialLibraryScanComplete,false);
  assert.equal((await f.post('/api/acquire-album?id=fixture-0')).status,503);
  await writeFile(f.disk,'fixture-disk');
  assert.equal((await f.post('/api/rescan')).status,200);
  assert.equal((await f.get('/api/health')).initialLibraryScanComplete,true);
  await f.acquire('fixture-0'); assert.equal((await f.terminal('fixture-0')).status,'complete');
});

test('explicitly opted-in jobs recover after restart with cancellable attempt state, legacy queues untouched', async t=>{
  const job={id:'fixture-8',artist:'Fixture Artist',title:'Resume Album',status:'running',origin:'manual',downloadOnly:true,
    publicationStarted:true,storageFailure:true,progress:0,priority:10,queuedAt:'2026-01-01T00:00:00Z',
    release:{id:'fixture-8',artist:'Fixture Artist',title:'Resume Album'}};
  const legacy={id:'legacy-queued',artist:'Legacy',title:'Legacy',status:'queued',origin:'manual',priority:1,
    automaticRepairSuppressed:true,release:{id:'legacy-queued',artist:'Legacy',title:'Legacy'}};
  const f=await startFixture(t,{jobs:[job,legacy]});
  await f.started('fixture-8');
  const queue=await f.queue();
  assert.equal(queue.find(r=>r.id==='fixture-8').publicationStarted,undefined);
  assert.equal(queue.find(r=>r.id==='fixture-8').storageFailure,undefined);
  assert.equal(queue.find(r=>r.id==='legacy-queued').status,'queued');
  assert.equal(queue.find(r=>r.id==='legacy-queued').automaticRepairSuppressed,true);
  assert.equal((await f.post('/api/acquisitions/cancel?id=fixture-8')).status,202);
  assert.equal((await f.terminal('fixture-8')).status,'cancelled');
  assert.equal((await readFile(f.log,'utf8')).trim(),'fixture-8');
});

test('cancelling during a retryable catalogue lookup never requeues the cancelled job', async t=>{
  const f=await startFixture(t);
  await f.acquire('fixture-9');
  await until(f.queue,rows=>rows.some(row=>row.id==='fixture-9'&&row.status==='resolving'),'lookup did not start');
  assert.equal((await f.post('/api/acquisitions/cancel?id=fixture-9')).status,202);
  const result=await f.terminal('fixture-9'); assert.equal(result.status,'cancelled');
  await pause(200); assert.equal((await f.queue()).find(row=>row.id==='fixture-9').status,'cancelled');
  await assert.rejects(access(f.log),{code:'ENOENT'});
});

test('cancelling while the downloaded album is validating leaves it in staging, never playable', async t=>{
  const f=await startFixture(t);
  await f.acquire('fixture-10'); await f.started('fixture-10');
  await until(f.queue,rows=>rows.some(row=>row.id==='fixture-10'&&row.message.startsWith('Validated;')),'validation did not start');
  assert.equal((await f.post('/api/acquisitions/cancel?id=fixture-10')).status,202);
  assert.equal((await f.terminal('fixture-10')).status,'cancelled');
  assert.equal((await f.get('/api/library')).tracks.length,0);
  assert.deepEqual(await readdir(f.albums),[]);
  assert.ok((await readdir(f.staging)).length>0);
});

test('publication collisions retain previous files and unsafe staging preparation settles without crashing', async t=>{
  const f=await startFixture(t);
  const previous=join(f.albums,'Fixture Artist','fixture-0'); await mkdir(previous,{recursive:true});
  await writeFile(join(previous,'owned.txt'),'keep existing bytes');
  await f.acquire('fixture-0'); const collision=await f.terminal('fixture-0');
  assert.equal(collision.status,'failed'); assert.match(collision.message,/already exists/);
  assert.equal(await readFile(join(previous,'owned.txt'),'utf8'),'keep existing bytes');
  const stage=join(f.staging,createHash('sha256').update('fixture-2').digest('hex'));
  await symlink(f.root,stage);
  await f.acquire('fixture-2'); const unsafe=await f.terminal('fixture-2');
  assert.equal(unsafe.status,'failed'); assert.match(unsafe.message,/symbolic links/);
  assert.equal((await f.get('/api/health')).readOnly,true);
  assert.deepEqual(await readFile(f.original),f.originalBytes);
});

test('cancellation force-stops a TERM-ignoring downloader before releasing queue ownership', async t=>{
  const f=await startFixture(t);
  await f.acquire('fixture-11'); await f.started('term-resistant-ready');
  await f.acquire('fixture-2');
  assert.equal((await f.post('/api/acquisitions/cancel?id=fixture-11')).status,202);
  await pause(200);
  assert.equal((await f.queue()).find(row=>row.id==='fixture-2').status,'queued');
  assert.equal((await readFile(f.log,'utf8')).includes('fixture-2'),false);
  assert.equal((await f.terminal('fixture-11')).status,'cancelled');
  assert.equal((await f.terminal('fixture-2')).status,'complete');
  assert.deepEqual((await readFile(f.log,'utf8')).trim().split('\n'),['fixture-11','term-resistant-ready','fixture-2']);
  assert.deepEqual(await readFile(f.original),f.originalBytes);
});


test('service termination stops a TERM-ignoring process group and preserves restartable queue ownership', async t=>{
  const f=await startFixture(t);
  await f.acquire('fixture-11'); await f.started('term-resistant-ready');
  const pid=Number((await readFile(f.pidFile,'utf8')).trim());
  assert.equal(await processGroupHasWriters(pid),true);
  await f.acquire('fixture-2');
  await f.stop();
  assert.equal(await processGroupHasWriters(pid),false,'no detached downloader survives service shutdown');
  const saved=JSON.parse(await readFile(join(f.data,'acquisitions.json'),'utf8')).items;
  assert.equal(saved.find(row=>row.id==='fixture-11').status,'running','restart retains an interrupted explicit job');
  assert.equal(saved.find(row=>row.id==='fixture-2').status,'queued');
  assert.deepEqual(await readdir(f.albums),[]);
  assert.ok((await readdir(f.staging)).length>0);
  assert.equal((await readFile(f.log,'utf8')).includes('fixture-2'),false);
  assert.deepEqual(await readFile(f.original),f.originalBytes);
});
