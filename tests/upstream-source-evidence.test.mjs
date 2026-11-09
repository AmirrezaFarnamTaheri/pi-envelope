import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const load=p=>JSON.parse(readFileSync(join(root,p),'utf8'));
test('all 16 pinned upstreams have source-level evidence and honest outstanding acceptance',()=>{
 const base=load('integrations/graph-source-audit.json');
 const evidence=load('integrations/upstream-source-evidence.json');
 assert.equal(evidence.schemaVersion,1);assert.equal(evidence.fullUpstreamParityClaimed,false);
 assert.equal(evidence.sources.length,16);assert.equal(base.upstreams.length,16);
 assert.deepEqual(evidence.sources.map(row=>row.repo),base.upstreams.map(row=>row.repo));
 for(let i=0;i<16;i++){
   const row=evidence.sources[i];assert.match(row.pinnedSha,/^[a-f0-9]{40}$/);
   assert.equal(row.pinnedSha,base.upstreams[i].commit);
   assert.equal(row.completePort,false);assert.equal(row.coverage,'partial');
   assert.ok(row.upstreamSourcePaths.length>=2);
   assert.ok(row.envelopeFiles.length&&row.verificationFiles.length);
   assert.ok(row.remainingAcceptance.length>=40);
   for(const path of [...row.envelopeFiles,...row.verificationFiles]){
     assert.ok(!path.startsWith('/')&&!path.split('/').includes('..'));
     assert.ok(existsSync(join(root,path)),row.repo+' missing local evidence: '+path);
   }
 }
});
