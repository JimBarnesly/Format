import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquisitionMarker, assertDownloadConfiguration, assertSafeStagingTree, downloadRequestAllowed,
  isDownloadOnlyJob, verifyDownloader, verifyDownloadStorage } from '../download-policy.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'format-download-policy-'));
  t.after(() => rm(temporary, {recursive:true,force:true}));
  const root = join(temporary,'music');
  const acquisitionRoot = join(root,'New Downloads');
  const config = {root,acquisitionRoot,downloadRoot:join(acquisitionRoot,'albums'),stagingRoot:join(acquisitionRoot,'staging'),
    filesystemUuid:'fixture-disk',host:'127.0.0.1'};
  await mkdir(config.downloadRoot,{recursive:true}); await mkdir(config.stagingRoot);
  await writeFile(join(acquisitionRoot,acquisitionMarker),JSON.stringify({schemaVersion:1,filesystemUuid:config.filesystemUuid}));
  return {temporary,config,mounts:async()=>[{uuid:'fixture-disk',target:'/fixture-mount'}]};
}

test('download-only configuration requires exact separated paths, a UUID, and loopback', async t => {
  const {config} = await fixture(t);
  assert.doesNotThrow(()=>assertDownloadConfiguration(config));
  for (const override of [{root:'/'},{root:'relative'},{acquisitionRoot:config.root},{acquisitionRoot:config.root+'-other'},
    {acquisitionRoot:join(config.root,'nested','child')},{downloadRoot:config.stagingRoot},{stagingRoot:config.downloadRoot},
    {stagingRoot:join(config.downloadRoot,'staging')},{filesystemUuid:''},{host:'0.0.0.0'}]) {
    assert.throws(()=>assertDownloadConfiguration({...config,...override}),{reason:'unsafe_configuration'});
  }
});

test('storage guard requires one correct HDD and one acquisition mount boundary, not only st_dev', async t => {
  const {config,mounts} = await fixture(t);
  await verifyDownloadStorage(config,{mounts});
  for (const found of [[],[{uuid:'wrong',target:'/fixture-mount'}],[{uuid:null,target:'/fixture-mount'}],[{uuid:'fixture-disk',target:'/'}]]) {
    await assert.rejects(verifyDownloadStorage(config,{mounts:async()=>found}),/HDD|boundary/);
  }
  await assert.rejects(verifyDownloadStorage(config,{mounts:async path=>[{uuid:'fixture-disk',target:path===config.stagingRoot?'/different-bind':'/fixture-mount'}]}),/mount boundary/);
  await assert.rejects(verifyDownloadStorage(config,{mounts,inspect:async path=>{
    const info=await lstat(path); if(path===config.stagingRoot) return {dev:info.dev+1,isDirectory:()=>true}; return info;
  }}),/same HDD/);
  await rm(config.stagingRoot,{recursive:true});
  await assert.rejects(verifyDownloadStorage(config,{mounts}),{code:'ENOENT'});
});

test('storage guard rejects symlinks in every writable path, marker, and ancestors', async t => {
  const {config,mounts,temporary} = await fixture(t);
  for(const path of [config.downloadRoot,config.stagingRoot,join(config.acquisitionRoot,acquisitionMarker),config.acquisitionRoot,config.root]) {
    const original=path+'.saved'; await rename(path,original); await symlink(original,path);
    await assert.rejects(verifyDownloadStorage(config,{mounts}),/symbolic links/);
    await rm(path); await rename(original,path);
  }
  await writeFile(join(config.acquisitionRoot,acquisitionMarker),JSON.stringify({schemaVersion:1,filesystemUuid:'wrong'}));
  await assert.rejects(verifyDownloadStorage(config,{mounts}),/ownership/);
  assert.ok(temporary);
});

test('low free space blocks acquisition without deleting media or staging', async t => {
  const {config,mounts} = await fixture(t);
  const file=join(config.stagingRoot,'retained.flac'); await writeFile(file,'retained');
  await assert.rejects(verifyDownloadStorage(config,{mounts,space:async()=>({bavail:100n,bsize:4096n})}),
    {reason:'storage_unavailable',message:/at least 1 GiB/});
  assert.equal(await readFile(file,'utf8'),'retained');
  await verifyDownloadStorage(config,{mounts,space:async()=>({bavail:262144n,bsize:4096n})});
});

test('downloader preflight checks an absolute reviewed executable without executing it', async t => {
  const {temporary} = await fixture(t);
  const executable=join(temporary,'downloader');
  const sentinel=join(temporary,'executed');
  await writeFile(executable,`#!/bin/sh\ntouch '${sentinel}'\n`,{mode:0o755});
  await verifyDownloader(executable);
  await assert.rejects(lstat(sentinel),{code:'ENOENT'});
  await assert.rejects(verifyDownloader('downloader'),{reason:'downloader_unavailable'});
  await chmod(executable,0o600);
  await assert.rejects(verifyDownloader(executable),{reason:'downloader_unavailable'});
  await chmod(executable,0o755); await symlink(executable,executable+'.link');
  await assert.rejects(verifyDownloader(executable+'.link'),{reason:'downloader_unavailable'});
});

test('staging tree rejects symbolic links and hard links before probing or publication', async t => {
  const {config,temporary} = await fixture(t);
  const source=join(temporary,'owned.flac'); await writeFile(source,'original');
  await writeFile(join(config.stagingRoot,'normal.flac'),'fixture');
  await assertSafeStagingTree(config.stagingRoot);
  const unsafe=join(config.stagingRoot,'unsafe.flac');
  await symlink(source,unsafe); await assert.rejects(assertSafeStagingTree(config.stagingRoot),/regular, unlinked/); await rm(unsafe);
  await link(source,unsafe); await assert.rejects(assertSafeStagingTree(config.stagingRoot),/regular, unlinked/);
  assert.equal(await readFile(source,'utf8'),'original');
});

test('only deliberately marked manual whole-album jobs can resume in download-only mode', () => {
  assert.equal(isDownloadOnlyJob({origin:'manual',downloadOnly:true}),true);
  for (const state of [null,{}, {origin:'manual'}, {origin:'discovery',downloadOnly:true},
    {origin:'automatic_repair',downloadOnly:true},{origin:'manual',downloadOnly:true,missingTracks:['1:2']}]) {
    assert.equal(isDownloadOnlyJob(state),false);
  }
});

test('native Kodi and same-origin requests work; cross-site, DNS rebinding, and LAN mutations fail', () => {
  const config={host:'127.0.0.1',port:4534};
  const request={socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:4534'}};
  assert.equal(downloadRequestAllowed(request,config),true);
  assert.equal(downloadRequestAllowed({...request,headers:{...request.headers,origin:'http://127.0.0.1:4534','sec-fetch-site':'same-origin'}},config),true);
  for(const headers of [{origin:'https://evil.invalid'},{origin:'null'},{host:'evil.invalid:4534'},{'sec-fetch-site':'cross-site'}]) {
    assert.equal(downloadRequestAllowed({...request,headers:{...request.headers,...headers}},config),false);
  }
  assert.equal(downloadRequestAllowed({...request,socket:{remoteAddress:'192.0.2.10'}},config),false);
});
