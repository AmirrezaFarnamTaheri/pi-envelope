import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
import {DatabaseSync} from 'node:sqlite';
import {OutputStore} from '../extensions/envelope/store.mjs';
import {ContextFrontier} from '../extensions/envelope/context-frontier.mjs';
import {projectContext} from '../extensions/envelope/context-projection.mjs';
import {CodeIndex} from '../extensions/envelope/code-index.mjs';
import {parseLanguageBatch} from '../extensions/envelope/parser-bridge.mjs';
import {inspectCodeGraph} from '../extensions/envelope/graph-intelligence.mjs';
import {splitIndexedChunks} from '../extensions/envelope/output-fragments.mjs';
import {registerEnvelope} from '../extensions/envelope/index.mjs';
function fixture(t) {const root=mkdtempSync(join(tmpdir(),'envelope-coderabbit-'));t.after(()=>rmSync(root,{force:true,recursive:true}));return root;}
function pythonIndex(t,files,opt={}) {const root=fixture(t);for(const [name,body] of Object.entries(files)){const dest=join(root,name);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,body);}assert.equal(spawnSync('git',['init','-q'],{cwd:root}).status,0);const index=new CodeIndex(root,{ts,languagesEnabled:true,...opt});return {index,root};}
const edge=(g)=>g.outgoing.some(e=>e.target.path==='pkg/math.py'&&e.target.name==='calculate');
const source=`import pkg.math as engine\ndef run():\n    return engine.calculate(1)\n`;

test('an unrelated nested Python class must not shadow a module alias',t=>{
 const {index}=pythonIndex(t,{'pkg/math.py':'def calculate():\n    return 1\n','pkg/service.py':`import pkg.math as engine\ndef unrelated():\n    class engine: pass\ndef run():\n    return engine.calculate()\n`});
 index.refresh();assert.ok(edge(index.calls('pkg/service.py')));
});

test('unindexed initializer and rebound target prevent invented Python call edges',t=>{
 const {index,root}=pythonIndex(t,{'pkg/math.py':'def calculate():\n    return 1\n','pkg/__init__.py':'x='+'0'.repeat(2000)+'\nmath=object()\n','pkg/service.py':'from . import math as ops\ndef run():\n    return ops.calculate()\n'},{maxBytesPerFile:500});
 index.refresh();assert.equal(index.calls('pkg/service.py').outgoing.length,0,'oversized initializer must fail closed');
 writeFileSync(join(root,'pkg/__init__.py'),'# empty\n');
 writeFileSync(join(root,'pkg/math.py'),'def calculate():\n    return 1\ncalculate = object()\n');
 index.refresh();assert.equal(index.calls('pkg/service.py').outgoing.length,0,'rebound target must fail closed');
});

test('conditional Python imports and function declarations shadow aliases, but comprehensions do not',t=>{
 const {index,root}=pythonIndex(t,{'pkg/math.py':'def calculate():\n    return 1\n','pkg/service.py':'import pkg.math as engine\nif True:\n    import pkg.other as engine\ndef run():\n    return engine.calculate()\n'});
 index.refresh();assert.equal(index.calls('pkg/service.py').outgoing.length,0);
 writeFileSync(join(root,'pkg/service.py'),'import pkg.math as engine\nif True:\n    def engine(): pass\ndef run():\n    return engine.calculate()\n');
 index.refresh();assert.equal(index.calls('pkg/service.py').outgoing.length,0);
 writeFileSync(join(root,'pkg/service.py'),'import pkg.math as engine\n[engine for engine in []]\ndef run():\n    return engine.calculate()\n');
 index.refresh();assert.ok(edge(index.calls('pkg/service.py')),'comprehension loop binding should be scoped');
});

test('exception handler binds a local Python name that shadows an imported module',t=>{
 const {index}=pythonIndex(t,{'pkg/math.py':'def calculate():\n    return 1\n','pkg/service.py':'import pkg.math as engine\ndef run():\n    try: pass\n    except Exception as engine:\n        return engine.calculate()\n'});
 index.refresh();assert.equal(index.calls('pkg/service.py').outgoing.length,0);
});

test('oversized Python alias list does not invalidate an entire parser batch',()=>{
 const imports=Array.from({length:1005},(_,i)=>`import pkg.module${i} as alias${i}`).join('\n');
 const report=parseLanguageBatch('python',[{path:'pkg/huge.py',content:imports},{path:'pkg/ok.py',content:'def fine():\n    return 1\n'}]);
 assert.equal(report.ok,true,report.reason);assert.equal(report.records.length,2);
 assert.ok(report.records[0].bindings.length<=1000);
 assert.equal(report.records[0].moduleBindingsTruncated,true);
 assert.ok(report.records[1].declarations.some(d=>d.name==='fine'));
});

test('Unicode tokenizer matches underscore and accent and previews actual matching positions',t=>{
 const home=fixture(t);const store=new OutputStore(home);t.after(()=>store.close());
 const text='filler '.repeat(160)+'permission_denied café final';const id=store.save({project:'/a',text}).id;
 const underscores=store.searchReport('permission',{project:'/a'});
 assert.equal(underscores.hits[0]?.id,id);assert.equal(underscores.coverage.integritySkipped,0);
 const a=store.searchReport('cafe',{project:'/a'}).hits[0];assert.ok(a?.excerpt.includes('café'),a?.excerpt);
 const fragment=store.searchFragmentsReport('cafe',{project:'/a'}).hits[0];assert.ok(fragment?.preview.includes('café'),fragment?.preview);
});

test('a long token crossing a chunk boundary is searchable and existing chunks are refreshed',t=>{
 const home=fixture(t);const store=new OutputStore(home);t.after(()=>store.close());
 const token='abcdef0123456789'.repeat(8);const text='x'.repeat(1099)+' '+token+' tail';
 assert.ok(splitIndexedChunks(text).some(chunk=>chunk.text.includes(token)));
 const id=store.save({project:'/a',text}).id;
 assert.equal(store.searchFragments(token,{project:'/a'}).at(0)?.id,id);
});

test('broken oldest backfill rows cannot starve healthy outputs and partial stays true',t=>{
 const home=fixture(t);const store=new OutputStore(home);t.after(()=>store.close());const ids=[];
 for(let i=0;i<12;i++) ids.push(store.save({project:'/a',text:`batch marker token ${i}`}).id);
 store.db.exec('DELETE FROM output_chunks_fts; DELETE FROM output_chunks_state;');
 for(const id of ids.slice(0,8))rmSync(store.objectPath(id));
 const first=store.searchFragmentsReport('marker',{project:'/a'});
 assert.ok(first.index.partial);
 assert.ok(first.hits.length>0,'healthy outputs must not be starved by broken oldest rows');
});

test('corrupt chunk candidates mark the report partial instead of presenting a complete empty result',t=>{
 const home=fixture(t);const store=new OutputStore(home);t.after(()=>store.close());
 const saved=store.save({project:'/a',text:'panic marker visible'});
 writeFileSync(store.objectPath(saved.id),'broken raw bytes');
 const result=store.searchFragmentsReport('panic',{project:'/a'});
 assert.equal(result.hits.length,0);assert.equal(result.index.partial,true);
 assert.ok(result.index.integritySkipped>0);
});

test('chunk deletion cleans all rows for authorized ID even if an FTS project field was modified',t=>{
 const home=fixture(t);const store=new OutputStore(home);t.after(()=>store.close());
 const s=store.save({project:'/a',text:'private zz token'});
 store.db.prepare('UPDATE output_chunks_fts SET project=? WHERE id=?').run('/b',s.id);
 assert.equal(store.erase({id:s.id,project:'/a'}),true);
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM output_chunks_fts WHERE id=?').get(s.id).n,0);
});

test('erasing output prevents historical context recapture through a new checkpoint',t=>{
 const home=fixture(t);const store=new OutputStore(join(home,'store'));const frontier=new ContextFrontier(join(home,'frontier'));t.after(()=>{store.close();frontier.close()});
 const original='PASS diagnostic evidence\n'.repeat(180);
 const messages=[{role:'user',content:'test'},
 {role:'assistant',content:[{type:'toolCall',id:'bash-1',name:'bash',arguments:{command:'npm test'}}]},
 {role:'toolResult',toolName:'bash',toolCallId:'bash-1',isError:false,content:[{type:'text',text:original}]},
 {role:'assistant',content:[{type:'toolCall',id:'checkpoint-1',name:'envelope_context_checkpoint'}]},
 {role:'toolResult',toolName:'envelope_context_checkpoint',toolCallId:'checkpoint-1',isError:false,content:[{type:'text',text:'ok'}]},
 {role:'assistant',content:[{type:'toolCall',id:'checkpoint-2',name:'envelope_context_checkpoint'}]},
 {role:'toolResult',toolName:'envelope_context_checkpoint',toolCallId:'checkpoint-2',isError:false,content:[{type:'text',text:'ok'}]},
 ...Array.from({length:8},()=>({role:'assistant',content:'remaining'}))];
 const opts={project:'/a',sessionId:'s1',store,frontier,minBytes:100,maxPreviewChars:400,recentMessages:1};
 const first=projectContext(messages,{...opts,anchorCallId:'checkpoint-1'});assert.equal(first.changed,true);
 const id=first.messages[2].content[0].text.match(/id=([0-9a-f]{64})/)[1];
 assert.equal(store.erase({id,project:'/a'}),true);
 const later=projectContext(messages,{...opts,anchorCallId:'checkpoint-2'});
 assert.equal(later.changed,false);assert.equal(store.stats({project:'/a'}).items,0);
});

test('frontier serializes concurrent initialization without schema collisions',t=>{
 const home=fixture(t),folder=join(home,'frontier');
 const a=new ContextFrontier(folder),b=new ContextFrontier(folder);t.after(()=>{a.close();b.close()});
 assert.equal(a.list({project:'/a',sessionId:'one',anchorCallId:'chk'}).version,1);
 assert.equal(b.list({project:'/a',sessionId:'one',anchorCallId:'chk'}).version,1);
});

test('Mermaid escaping does not create extra nodes when a file path contains quotes or brackets',t=>{
 const {index}=pythonIndex(t,{'src/a"]b.ts':'export const a=1;','src/n.ts':'export const n=2;'});
 index.refresh();const d=inspectCodeGraph(index,{action:'export',format:'mermaid'});
 assert.match(d.content,/#quot;|&#34;|&quot;/);assert.doesNotMatch(d.content,/\\"/);
});


test('context hook keeps its actual input array immutable after projection and replay',t=>{
 const root=fixture(t),frontier=new ContextFrontier(join(root,'frontier')),store=new OutputStore(join(root,'output'));
 t.after(()=>{frontier.close();store.close();});
 const original='PASS stable original\n'.repeat(180);
 const messages=[{role:'user',content:'run'},
   {role:'assistant',content:[{type:'toolCall',id:'bash-1',name:'bash',arguments:{command:'npm test'}}]},
   {role:'toolResult',toolCallId:'bash-1',toolName:'bash',isError:false,content:[{type:'text',text:original}]},
   {role:'assistant',content:[{type:'toolCall',id:'checkpoint-1',name:'envelope_context_checkpoint'}]},
   {role:'toolResult',toolCallId:'checkpoint-1',toolName:'envelope_context_checkpoint',isError:false,content:[{type:'text',text:'ok'}]},
   ...Array.from({length:8},()=>({role:'assistant',content:'next'}))];
 const snapshot=structuredClone(messages);
 const opt={project:'/a',sessionId:'s1',anchorCallId:'checkpoint-1',store,frontier,minBytes:100,maxPreviewChars:400,recentMessages:1};
 const projected=projectContext(messages,opt);
 assert.equal(projected.changed,true);assert.deepEqual(messages,snapshot);
 assert.deepEqual(projectContext(messages,opt).messages,projected.messages);
 assert.deepEqual(messages,snapshot);
});

test('nitpick: parser truncates >1000 assigned names and preserves conservative initializer evidence',t=>{
 const source=Array.from({length:1002},(_,i)=>`var_${String(i).padStart(4,'0')} = ${i}`).join('\n');
 const parsed=parseLanguageBatch('python',[{path:'pkg/__init__.py',content:source}]);
 assert.equal(parsed.ok,true,parsed.reason);
 const row=parsed.records[0];
 assert.equal(row.moduleAssigned.length,1000);
 assert.equal(row.moduleBindingsTruncated,true);
 const {index}=pythonIndex(t,{'pkg/math.py':'def calculate():\n    return 1\n',
   'pkg/__init__.py':source+'\nzzzz_competing = True\nmath = object()\n',
   'pkg/service.py':'from . import math as ops\ndef run():\n    return ops.calculate()\n'});
 index.refresh();
 const report=index.calls('pkg/service.py');
 assert.equal(report.outgoing.length,0);
 assert.equal(report.unresolved[0]?.reason,'ambiguous-target');
});

test('nitpick: raw-byte verification cap triggers below the distinct-output limit',t=>{
 const home=fixture(t),store=new OutputStore(home);t.after(()=>store.close());
 for(let i=0;i<6;i++) {
   const text=`shared budget signal ${i} `+' '.repeat(1_620_000);
   store.save({project:'/a',text});
 }
 const report=store.searchFragmentsReport('shared budget',{project:'/a',limit:20});
 assert.equal(store.chunkIndexStatus('/a').pending,0);
 assert.ok(report.index.verificationLimited,'8MB must cap verification before 40 outputs');
 assert.equal(report.index.partial,true);
 assert.ok(report.hits.length>0);
});

test('legacy exact recall remains available when optional chunk-schema initialization is malformed',t=>{
 const home=fixture(t),store=new OutputStore(home);
 const item=store.save({project:'/a',text:'legacy exact content'});
 store.close();
 const db=new DatabaseSync(join(home,'index.sqlite'));
 db.exec('DROP TABLE output_chunks_fts; DROP TABLE output_chunks_state; CREATE VIEW output_chunks_state AS SELECT 123 AS broken;');
 db.close();
 const reopened=new OutputStore(home);t.after(()=>reopened.close());
 assert.equal(reopened.retrieve(item.id).text,'legacy exact content');
 assert.equal(reopened.chunkAvailable,false);
 const report=reopened.searchFragmentsReport('legacy',{project:'/a'});
 assert.equal(report.index.indexUnavailable,true);
 assert.equal(report.index.partial,true);
});

test('model sees partial search coverage while legacy first text block remains a JSON array',async t=>{
 const home=fixture(t),tools=new Map(),hooks=new Map();
 const pi={cwd:'/a',on(n,f){hooks.set(n,f);},registerTool(x){tools.set(x.name,x);},registerCommand(){},logger:{warn(){}}};
 const app=registerEnvelope(pi,{home});t.after(()=>app.close());
 const store=new OutputStore(join(home,'envelope-output'));t.after(()=>store.close());
 const a=store.save({project:'/a',text:'visible keyword blah'});
 store.db.exec('DELETE FROM output_chunks_fts; DELETE FROM output_chunks_state;');
 const cmd=tools.get('envelope_search_fragments');
 // Force a partial legacy search by leaving a missing historical object.
 rmSync(store.objectPath(a.id));
 const result=await cmd.execute('x',{query:'visible'},null,null,{cwd:'/a'});
 assert.equal(result.isError,false);
 assert.deepEqual(JSON.parse(result.content[0].text),[]);
 assert.ok(result.content[1]?.text.includes('incomplete'));
 assert.equal(result.details.chunkIndex.partial,true);
 const whole=await tools.get('envelope_search_output').execute('x',{query:'visible'},null,null,{cwd:'/a'});
 assert.ok(whole.content.some(x=>x.text.includes('incomplete')));
 assert.equal(whole.details.searchCoverage.partial,true);
});

test('legacy exact recall survives a broken erasure schema while history recapture and erase fail closed',t=>{
 const home=fixture(t),store=new OutputStore(home);
 const saved=store.save({project:'/a',text:'legacy recall still available'});store.close();
 const db=new DatabaseSync(join(home,'index.sqlite'));
 db.exec('DROP TABLE output_erasure_tombstones; CREATE VIEW output_erasure_tombstones AS SELECT 1 AS broken;');
 db.close();
 const reopened=new OutputStore(home);t.after(()=>reopened.close());
 assert.equal(reopened.retrieve(saved.id).text,'legacy recall still available');
 assert.equal(reopened.erasureAvailable,false);
 assert.throws(()=>reopened.isErased(saved.id,'/a'),/erasure protection unavailable/);
 assert.throws(()=>reopened.erase({id:saved.id,project:'/a'}),/erasure protection unavailable/);
});
