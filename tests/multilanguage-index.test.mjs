import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';

const have=(bin)=>spawnSync(bin,[bin==='go'?'version':'--version'],{encoding:'utf8',timeout:4000}).status===0;
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'envelope-ml-index-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const files={
  'api.ts':'export function existing() { return 1; }\n',
  'pkg/__init__.py':'# package\n',
  'pkg/math.py':'def plus(a, b):\n    return a+b\n',
  'pkg/main.py':'from .math import plus\nclass Client:\n    def send(self):\n        return plus(2,3)\n',
  'pkg/dynamic.py': 'import importlib\nplugin = importlib.import_module("pkg.math")\n',
  'go.mod':'module example.com/envelope\n\ngo 1.20\n',
  'lib/compute.go':'package lib\nfunc Calculate() int { return 5 }\n',
  'cmd/app.go':'package cmd\nimport "example.com/envelope/lib"\nfunc Run() int { return lib.Calculate() }\n',
  'src/external.py': 'def BAD(): pass\n'
 };
 for(const [p,v] of Object.entries(files)){mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),v)}
 mkdirSync(join(root,'node_modules'),{recursive:true});writeFileSync(join(root,'node_modules','ignored.py'),'def secret():pass\n');
 assert.equal(spawnSync('git',['init','-q'],{cwd:root}).status,0);
 return root;
}

test('optional parsers are opt-in; JS/TS remains the original default',t=>{
 const root=fixture(t);const index=new CodeIndex(root,{ts});index.refresh();
 assert.equal(index.lookup('existing').length,1);
 assert.deepEqual(index.lookup('Calculate'),[]);
 assert.deepEqual(index.lookup('plus'),[]);
 assert.throws(()=>index.verify('pkg/main.py'),/indexed|ignored/i);
});

test('Python local modules and Go module imports produce conservative static impact', {skip:!have('python3')||!have('go')},t=>{
 const root=fixture(t);
 const index=new CodeIndex(root,{ts,languagesEnabled:true});const stats=index.refresh();
 assert.equal(stats.files,8);
 const plus=index.lookup('plus');assert.equal(plus[0].path,'pkg/math.py');
 const method=index.lookup('send');assert.equal(method[0].container,'Client');
 assert.deepEqual(index.impact('pkg/math.py').importers.map(x=>x.path),['pkg/main.py']);
 assert.deepEqual(index.impact('lib/compute.go').importers.map(x=>x.path),['cmd/app.go']);
 assert.ok(index.lookup('Calculate').some(x=>x.path==='lib/compute.go'));
 assert.deepEqual(index.impact('pkg/dynamic.py').importers,[]);
 writeFileSync(join(root,'math.py'),'def outer(): pass\n');
 writeFileSync(join(root,'pkg/dynamic.py'),'from ..math import plus\n');
 index.refresh();
 assert.deepEqual(index.impact('pkg/math.py').importers.map(x=>x.path),['pkg/main.py']);
 assert.deepEqual(index.impact('math.py').importers,[]);
 assert.equal(index.verify('pkg/main.py').ok,true);
 assert.equal(index.verify('cmd/app.go').ok,true);
 const report=index.verify('pkg/main.py',{content:'def broken(:\n'});
 assert.equal(report.ok,false);assert.equal(report.diagnostics[0].code,'PY_SYNTAX');
 assert.equal(index.verify('cmd/app.go',{content:'package cmd\nfunc broken( {\n'}).ok,false);
 assert.match(readFileSync(join(root,'pkg','main.py'),'utf8'),/class Client/);
});

test('unavailable optional parsers never pretend clean or poison the TS index',t=>{
 const root=fixture(t);
 const index=new CodeIndex(root,{ts,languagesEnabled:true,parserOptions:{pythonCommand:'envelope-missing-python',goCommand:'envelope-missing-go'}});
 const stats=index.refresh();
 assert.equal(stats.files,1);assert.equal(stats.unavailable.length,2);
 assert.equal(index.lookup('existing').length,1);
 assert.throws(()=>index.verify('pkg/main.py'),/not indexed|parser/i);
});

test('changed Python/Go sources refresh cached symbols without losing JS/TS', {skip:!have('python3')||!have('go')},t=>{
 const root=fixture(t),idx=new CodeIndex(root,{ts,languagesEnabled:true});idx.refresh();
 const unchanged=idx.refresh();assert.equal(unchanged.reparsed,0);
 writeFileSync(join(root,'pkg/math.py'),'def replacement(a):\n    return a\n');
 writeFileSync(join(root,'lib/compute.go'),'package lib\nfunc Replaced() int { return 7 }\n');
 const changed=idx.refresh();assert.equal(changed.reparsed,2);
 assert.ok(idx.lookup('replacement').length>0);assert.equal(idx.lookup('plus').length,0);
 assert.ok(idx.lookup('Replaced').length>0);assert.equal(idx.lookup('Calculate').length,0);
});

test('Python from-import and Go module package calls have bounded, conservative source evidence', {skip:!have('python3')||!have('go')},t=>{
 const root=fixture(t);
 const put=(p,text)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),text)};
 put('pkg/shadow.py',`from .math import plus

def local(plus):
    return plus(2)

def dynamic(client):
    return client.plus(4)
`);
 put('lib/second.go',`package lib
func Double() int { return Calculate() }
`);
 put('cmd/shadow.go',`package cmd
import "example.com/envelope/lib"
func Shadow(lib interface{ Calculate() int }) int { return lib.Calculate() }
`);
 const index=new CodeIndex(root,{ts,languagesEnabled:true});index.refresh();
 const python=index.calls('pkg/main.py');
 assert.ok(python.outgoing.some(x=>x.caller.name==='Client.send'&&x.target.path==='pkg/math.py'&&x.name==='plus'));
 assert.ok(index.calls('pkg/math.py').incoming.some(x=>x.path==='pkg/main.py'));
 const shadow=index.calls('pkg/shadow.py');
 assert.ok(shadow.unresolved.some(x=>x.name==='plus'&&x.reason==='shadowed'));
 assert.ok(shadow.unresolved.some(x=>x.name==='plus'&&x.reason==='dynamic-member'));
 const go=index.calls('cmd/app.go');
 assert.ok(go.outgoing.some(x=>x.name==='Calculate'&&x.target.path==='lib/compute.go'));
 const internal=index.calls('lib/second.go');
 assert.ok(internal.outgoing.some(x=>x.name==='Calculate'&&x.resolution==='same-package'));
 const goShadow=index.calls('cmd/shadow.go');
 assert.ok(goShadow.unresolved.some(x=>x.name==='Calculate'&&x.reason==='shadowed'));
 assert.ok(goShadow.outgoing.every(x=>x.name!=='Calculate'));
});

test('optional language source changes invalidate call links; unavailable parser is explicit', {skip:!have('python3')||!have('go')},t=>{
 const root=fixture(t),index=new CodeIndex(root,{ts,languagesEnabled:true});
 index.refresh();
 assert.ok(index.calls('pkg/math.py').incoming.length>0);
 writeFileSync(join(root,'pkg/math.py'),'def renamed(a,b): return a+b\n');
 const refreshed=index.refresh();
 assert.equal(refreshed.reparsed,1);
 assert.equal(index.calls('pkg/math.py').incoming.length,0);
 assert.ok(index.calls('pkg/main.py').unresolved.some(x=>x.name==='plus'));
 const unavailable=new CodeIndex(root,{ts,languagesEnabled:true,parserOptions:{pythonCommand:'missing-envelope-py',goCommand:'missing-envelope-go'}});
 const stats=unavailable.refresh();
 assert.ok(stats.unavailable.length===2);
 assert.equal(stats.callSites,0);
 assert.throws(()=>unavailable.calls('pkg/main.py'),/not indexed|path/i);
});

test('Go import path directory does not prove the declared package name', {skip:!have('go')},t=>{
 const root=fixture(t);
 mkdirSync(join(root,'odd'),{recursive:true});
 writeFileSync(join(root,'odd','service.go'),'package othername\nfunc Reachable() int { return 1 }\n');
 writeFileSync(join(root,'cmd','wrong.go'),'package cmd\nimport "example.com/envelope/odd"\nfunc Wrong() int { return odd.Reachable() }\n');
 const index=new CodeIndex(root,{ts,languagesEnabled:true});index.refresh();
 assert.ok(index.calls('cmd/wrong.go').unresolved.some(x=>x.name==='Reachable'));
 assert.equal(index.calls('cmd/wrong.go').outgoing.length,0);
});
