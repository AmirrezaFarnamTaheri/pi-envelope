import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutputStore } from '../extensions/envelope/store.mjs';

function fixture(t){
 const home=mkdtempSync(join(tmpdir(),'envelope-output-integrity-'));
 const store=new OutputStore(join(home,'db'));
 t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
 return {home,store};
}

test('exact recall rejects tampered object bytes instead of presenting them as archived evidence',t=>{
 const {store}=fixture(t);
 const item=store.save({text:'original test output',project:'/a'});
 writeFileSync(store.objectPath(item.id),'tampered text');
 assert.throws(()=>store.retrieve(item.id),/integrity|mismatch|tamper/i);
 assert.throws(()=>store.save({text:'original test output',project:'/a'}),/integrity|mismatch|tamper/i);
});

test('exact recall never follows a replaced output object symlink',t=>{
 const {home,store}=fixture(t);
 const item=store.save({text:'original test output',project:'/a'});
 const target=join(home,'secret.txt');writeFileSync(target,'private text');
 rmSync(store.objectPath(item.id));
 symlinkSync(target,store.objectPath(item.id));
 assert.throws(()=>store.retrieve(item.id),/symlink|regular|integrity|invalid/i);
 assert.throws(()=>store.save({text:'original test output',project:'/a'}),/symlink|regular|integrity|invalid/i);
});
