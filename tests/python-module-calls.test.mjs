import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';

const enabled = spawnSync('python3', ['--version'], {timeout:3000}).status===0;
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'envelope-python-module-calls-'));
  t.after(()=>rmSync(root,{force:true,recursive:true}));
  const put=(file,source)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),source);};
  put('pkg/__init__.py','# Package root\n');
  put('pkg/math.py','def calculate(value):\n    return value + 1\n');
  put('pkg/service.py','def empty():\n    return 0\n');
  assert.equal(spawnSync('git',['init','-q'],{cwd:root,timeout:5000}).status,0);
  const index=new CodeIndex(root,{ts,languagesEnabled:true});
  return {put,index};
}
const hasEdge=(graph,caller,name,file)=>graph.outgoing.some(x=>x.caller.name===caller && x.name===name && x.target.path===file);
const unresolved=(graph,caller,name)=>graph.unresolved.find(x=>x.caller.name===caller && x.name===name);

test('Python import module as alias links unshadowed member calls with exact reverse evidence', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/service.py',`import pkg.math as engine

def solve():
    return engine.calculate(2)

async def compute():
    return engine.calculate(3)
`);
  const refresh=index.refresh();assert.equal(refresh.unavailable.length,0);
  const out=index.calls('pkg/service.py');
  assert.ok(hasEdge(out,'solve','calculate','pkg/math.py'),JSON.stringify(out));
  assert.ok(hasEdge(out,'compute','calculate','pkg/math.py'));
  const reverse=index.calls('pkg/math.py');
  assert.ok(reverse.incoming.some(x=>x.path==='pkg/service.py'&&x.caller.name==='solve'));
  assert.ok(out.outgoing.every(x=>x.resolution==='python-module-import'));
});

test('Python from-dot import module as alias resolves indexed module, not package initializer', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/service.py',`from . import math as ops
class Worker:
    def work(self):
        return ops.calculate(4)
`);
  index.refresh();
  const out=index.calls('pkg/service.py');
  assert.ok(hasEdge(out,'Worker.work','calculate','pkg/math.py'),JSON.stringify(out));
  assert.equal(out.outgoing.length,1);
});

test('Python plain import module and dotted import do not falsely resolve nested receivers', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/service.py',`import pkg.math
import some_external as foreign

def run():
    return pkg.math.calculate(1) + foreign.calculate(2)
`);
  index.refresh();const graph=index.calls('pkg/service.py');
  assert.equal(graph.outgoing.length,0);
  assert.ok(unresolved(graph,'run','calculate'));
});

test('Python module-level loop or conditional rebind forbids static module alias edges', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/service.py',`import pkg.math as engine
if True:
    engine = object()
def run():
    return engine.calculate(1)
`);
  index.refresh();const graph=index.calls('pkg/service.py');
  assert.equal(graph.outgoing.length,0);
  assert.equal(unresolved(graph,'run','calculate')?.reason,'shadowed');
  put('pkg/service.py',`import pkg.math as engine
for engine in []:
    pass
def run():
    return engine.calculate(1)
`);
  index.refresh();const changed=index.calls('pkg/service.py');
  assert.equal(changed.outgoing.length,0);
  assert.equal(unresolved(changed,'run','calculate')?.reason,'shadowed');
});

test('Python module aliases are not resolved when shadowed by function parameters or local assignments', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/service.py',`import pkg.math as engine

def shadowed(engine):
    return engine.calculate(1)

def overwritten():
    engine = None
    return engine.calculate(2)

def valid():
    return engine.calculate(3)
`);
  index.refresh();const graph=index.calls('pkg/service.py');
  assert.equal(unresolved(graph,'shadowed','calculate')?.reason,'shadowed');
  assert.equal(unresolved(graph,'overwritten','calculate')?.reason,'shadowed');
  assert.ok(hasEdge(graph,'valid','calculate','pkg/math.py'));
});

test('duplicate module bindings and duplicate source definitions fail closed as ambiguous', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/other.py','def calculate():\n    return 9\n');
  put('pkg/service.py',`import pkg.math as engine
import pkg.other as engine
def run():
    return engine.calculate()
`);
  index.refresh();const out=index.calls('pkg/service.py');
  assert.equal(out.outgoing.length,0);
  assert.equal(unresolved(out,'run','calculate')?.reason,'ambiguous-import');
  put('pkg/service.py',`import pkg.math as engine

def run():
    return engine.calculate()
`);
  put('pkg/math.pyi','def calculate(value): ...\n');
  index.refresh();const ambiguous=index.calls('pkg/service.py');
  assert.equal(ambiguous.outgoing.length,0);
  assert.equal(unresolved(ambiguous,'run','calculate')?.reason,'ambiguous-target');
});

test('Python same-file declaration and imported binding name cannot silently select a target', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/service.py',`from .math import calculate

def calculate(value):
    return value

def run():
    return calculate(1)
`);
  index.refresh();const out=index.calls('pkg/service.py');
  assert.equal(out.outgoing.length,0,JSON.stringify(out));
  assert.equal(unresolved(out,'run','calculate')?.reason,'ambiguous-target');
});

test('Python alias resolution revalidates edits and never links files outside indexed project', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/service.py',`import pkg.math as engine
def run():
    return engine.calculate(1)
`);
  index.refresh();assert.equal(index.calls('pkg/service.py').totalOutgoing,1);
  assert.equal(index.refresh().reparsed,0);
  put('pkg/math.py','def updated(value):\n    return value\n');
  index.refresh();const stale=index.calls('pkg/service.py');
  assert.equal(stale.totalOutgoing,0);
  assert.equal(unresolved(stale,'run','calculate')?.reason,'unknown-target');
  assert.throws(()=>index.calls('../outside.py'),/outside|root/i);
});

test('Python initializer assignment or re-export makes from-dot module binding ambiguous', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/__init__.py','math = object()\n');
  put('pkg/service.py',`from . import math as ops

def run():
    return ops.calculate(2)
`);
  index.refresh();let report=index.calls('pkg/service.py');
  assert.equal(report.outgoing.length,0);
  assert.equal(unresolved(report,'run','calculate')?.reason,'ambiguous-target');
  put('pkg/__init__.py','from .other import math\n');
  put('pkg/other.py','def math():\n    return None\n');
  index.refresh();report=index.calls('pkg/service.py');
  assert.equal(report.outgoing.length,0);
  assert.equal(unresolved(report,'run','calculate')?.reason,'ambiguous-target');
});

test('Python initializer declaration named after a module prevents a guessed submodule call', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/__init__.py','def math():\n    return None\n');
  put('pkg/service.py',`from . import math as ops

def run():
    return ops.calculate(2)
`);
  index.refresh();const report=index.calls('pkg/service.py');
  assert.equal(report.outgoing.length,0);
  assert.equal(unresolved(report,'run','calculate')?.reason,'ambiguous-target');
});

test('Python declaration or second import reusing a module alias prevents member-call linking', {skip:!enabled}, t=>{
  const {put,index}=fixture(t);
  put('pkg/service.py',`import pkg.math as engine

def engine():
    return None

def run():
    return engine.calculate(1)
`);
  index.refresh();const declaration=index.calls('pkg/service.py');
  assert.equal(declaration.outgoing.length,0);
  assert.equal(unresolved(declaration,'run','calculate')?.reason,'ambiguous-target');
  put('pkg/service.py',`import pkg.math as engine
from .other import engine

def run():
    return engine.calculate(2)
`);
  put('pkg/other.py','def engine():\n    return None\n');
  index.refresh();const rebound=index.calls('pkg/service.py');
  assert.equal(rebound.outgoing.length,0);
  assert.equal(unresolved(rebound,'run','calculate')?.reason,'ambiguous-import');
});

test('Python parser evidence keeps module aliases and initializer rebinding metadata bounded and validated', {skip:!enabled}, async ()=>{
  const { parseLanguageBatch, validateCallFacts } = await import('../extensions/envelope/parser-bridge.mjs');
  const parsed=parseLanguageBatch('python',[{path:'pkg/service.py',content:`import pkg.math as engine
from . import helper as local
if True:
    engine = None

def run():
    return local.calculate(1)
`}]);
  assert.equal(parsed.ok,true,parsed.reason);
  const data=parsed.records[0];
  assert.deepEqual(data.bindings.map(x=>[x.kind,x.local,x.spec]),[
    ['namespace','engine','pkg.math'],['namespace','local','.helper']
  ]);
  assert.deepEqual(data.moduleAssigned,['engine']);
  assert.equal(data.moduleBindingsTruncated,false);
  assert.equal(validateCallFacts(data),true);
  assert.equal(validateCallFacts({...data,moduleAssigned:[null]}),false);
  assert.equal(validateCallFacts({...data,moduleBindingsTruncated:'false'}),false);
  assert.equal(validateCallFacts({...data,moduleAssigned:Array.from({length:1001},()=> 'name')}),false);
  assert.equal(validateCallFacts({...data,bindings:[{...data.bindings[1],fromPackage:42}]}),false);
});

test('Python optional module analysis never executes parsed imports or module code', {skip:!enabled}, async ()=>{
  const { parseLanguageBatch } = await import('../extensions/envelope/parser-bridge.mjs');
  const contents=`import pkg.math as engine
raise RuntimeError('would have executed')

def run():
    return engine.calculate(2)
`;
  const result=parseLanguageBatch('python',[{path:'pkg/service.py',content:contents}]);
  assert.equal(result.ok,true,result.reason);
  assert.equal(result.records[0].calls[0].name,'calculate');
  assert.equal(result.records[0].bindings[0].spec,'pkg.math');
});
