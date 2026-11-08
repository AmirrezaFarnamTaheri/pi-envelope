import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseLanguageBatch, validateCallFacts } from '../extensions/envelope/parser-bridge.mjs';

const has=(exe)=>spawnSync(exe,[exe==='go'?'version':'--version'],{encoding:'utf8',timeout:3000}).status===0;

test('Python stdlib AST extracts declarations/imports and reports grounded syntax errors', {skip:!has('python3')},()=>{
  const contents='import pkg.util\nfrom . import math\nclass Café:\n    def méthode(self):\n        return 3\nasync def process():\n    return 1\n';
  const r=parseLanguageBatch('python',[{path:'pkg/service.py',content:contents}]);
  assert.equal(r.ok,true,r.reason);
  const p=r.records[0];
  assert.deepEqual(p.imports,['pkg.util','.math']);
  assert.deepEqual(p.symbols.map(x=>[x.name,x.kind,x.line,x.container]),[
    ['Café','class',3,''],['méthode','method',4,'Café'],['process','function',6,'']
  ]);
  assert.deepEqual(p.diagnostics,[]);
  const syntax=parseLanguageBatch('python',[{path:'pkg/bad.py',content:'def broken(:\n  pass\n'}]);
  assert.equal(syntax.ok,true);assert.ok(syntax.records[0].diagnostics.length>0);
  assert.equal(syntax.records[0].diagnostics[0].line,1);
});

test('Python parsing never executes top-level project code', {skip:!has('python3')},()=>{
  const source='raise RuntimeError("Do not run this")\nimport os\n';
  const r=parseLanguageBatch('python',[{path:'not_executed.py',content:source}]);
  assert.equal(r.ok,true,r.reason);assert.deepEqual(r.records[0].imports,['os']);
  assert.deepEqual(r.records[0].diagnostics,[]);
});

test('Go stdlib parser extracts declarations/imports and reports syntax errors', {skip:!has('go')},()=>{
  const src='package demo\nimport "example.com/project/pkg/util"\ntype Service struct{}\nfunc (s Service) Run() int { return 1 }\nfunc Hello() {}\n';
  const r=parseLanguageBatch('go',[{path:'pkg/demo/service.go',content:src}]);
  assert.equal(r.ok,true,r.reason);
  const p=r.records[0];
  assert.deepEqual(p.imports,['example.com/project/pkg/util']);
  assert.ok(p.symbols.some(x=>x.name==='Service' && x.kind==='struct'));
  assert.ok(p.symbols.some(x=>x.name==='Run'&&x.kind==='method'&&x.line===4));
  assert.ok(p.symbols.some(x=>x.name==='Hello'&&x.kind==='function'));
  assert.deepEqual(p.diagnostics,[]);
  const utf16=parseLanguageBatch('go',[{path:'unicode.go',content:'package demo\n/*🙂*/ func Hello() {}\n'}]);
  assert.equal(utf16.ok,true,utf16.reason);
  assert.equal(utf16.records[0].symbols.find(x=>x.name==='Hello').column,13);
  const bad=parseLanguageBatch('go',[{path:'pkg/demo/bad.go',content:'package demo\nfunc broken( {\n'}]);
  assert.equal(bad.ok,true,bad.reason);assert.ok(bad.records[0].diagnostics.length>0);
});

test('bridge degrades explicitly on missing programs and refuses unbounded or malformed requests',()=>{
  assert.equal(parseLanguageBatch('python',[{path:'src/a.py',content:'x=1'}],{pythonCommand:'envelope-no-python-executable'}).ok,false);
  assert.equal(parseLanguageBatch('go',[{path:'src/a.go',content:'package a'}],{goCommand:'envelope-no-go-executable'}).ok,false);
  assert.equal(parseLanguageBatch('rust',[]).ok,false);
  assert.equal(parseLanguageBatch('python',[{path:'src/a.py',content:'x'.repeat(4096)}],{maxInputBytes:100}).ok,false);
  assert.equal(parseLanguageBatch('python',[{path:'../outside.py',content:'pass'}]).ok,false);
  assert.equal(parseLanguageBatch('python',[{path:'src/a.py',content:'pass'}],{pythonCommand:'python3',maxOutputBytes:12}).ok,false);
});

test('call evidence parser contracts reject oversized or malformed nested evidence',()=>{
 const valid={declarations:[{name:'compute',line:2,exported:true}],
   bindings:[{kind:'named',local:'sum',imported:'compute',spec:'.helpers'}],
   calls:[{name:'sum',form:'direct',receiver:'',caller:{name:'run',line:3},line:4,column:2,shadowed:false}],
   omittedCalls:0,package:null};
 assert.equal(validateCallFacts(valid),true);
 assert.equal(validateCallFacts({}),true); // compatibility with earlier parser responses
 assert.equal(validateCallFacts({...valid,calls:[{...valid.calls[0],form:'shell'}]}),false);
 assert.equal(validateCallFacts({...valid,calls:[{...valid.calls[0],line:0}]}),false);
 assert.equal(validateCallFacts({...valid,calls:[{...valid.calls[0],caller:{name:'run',line:-1}}]}),false);
 assert.equal(validateCallFacts({...valid,calls:Array.from({length:201},()=>valid.calls[0])}),false);
 assert.equal(validateCallFacts({...valid,declarations:[{name:'x'.repeat(129),line:1}]}),false);
 assert.equal(validateCallFacts({...valid,bindings:[{kind:'package',local:'pkg',spec:'../bad',explicit:'yes'}]}),false);
 assert.equal(validateCallFacts({...valid,omittedCalls:-1}),false);
});
