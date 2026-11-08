import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { CodeIndex } from '../extensions/envelope/code-index.mjs';
import { TreeSitterBroker, treeGrammarForPath, namedTreeQuery } from '../extensions/envelope/tree-sitter-broker.mjs';

function setup(t, options={}) {
  const root=mkdtempSync(join(tmpdir(),'envelope-tree-broker-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'src'));
  writeFileSync(join(root,'src','app.ts'),'export function sum(x: number) { return x + 1; }\n');
  writeFileSync(join(root,'src','tool.py'),'def execute():\n    return 42\n');
  const index=new CodeIndex(root,{ts,maxFiles:50,maxBytesPerFile:512_000,languagesEnabled:options.languagesEnabled??false});
  index.refresh();
  let initCount=0, languageLoadCount=0, disposeCount=0;
  const calls=[];
  let queryMatches=options.queryMatches??[{
    patternIndex:0,
    captures:[{name:'name',node:{type:'identifier',text:'sum',startPosition:{row:0,column:16},endPosition:{row:0,column:19}}}]
  }];
  class Parser {
    static async init(){initCount++;}
    setLanguage(language){this.lang=language;}
    parse(source){calls.push({op:'parse',source});return {rootNode:{source,hasError(){return false;}},delete(){disposeCount++;}};}
    delete(){disposeCount++;}
  }
  class Language {static async load(path){languageLoadCount++;calls.push({op:'language',path});return {path};}}
  class Query {
    constructor(language,source){this.source=source;calls.push({op:'query',source});}
    matches(root,options){calls.push({op:'matches',options});return typeof queryMatches==='function'?queryMatches(root):queryMatches;}
    captures(root,options){calls.push({op:'captures',options});return (typeof queryMatches==='function'?queryMatches(root):queryMatches).flatMap(m=>m.captures??[]);}
    didExceedMatchLimit(){return Boolean(options.exceeded);}
    delete(){disposeCount++;}
  }
  const broker=new TreeSitterBroker({loadRuntime:async()=>({Parser,Language,Query}),getGrammarPath:async(language)=>`/mock/${language}.wasm`});
  return {root,index,broker,calls,counts:()=>({initCount,languageLoadCount,disposeCount}),setMatches(v){queryMatches=v}};
}

test('supports project-indexed TypeScript S-expression queries using real Tree-sitter API boundaries',async t=>{
  const h=setup(t);
  const output=await h.broker.run(h.index,{path:'src/app.ts',query:'(function_declaration name: (identifier) @name)',mode:'query',limit:5});
  assert.equal(output.language,'typescript');
  assert.equal(output.path,'src/app.ts');
  assert.equal(output.mode,'query');
  assert.equal(output.matches.length,1);
  assert.equal(output.matches[0].captures[0].text,'sum');
  assert.equal(output.matches[0].captures[0].start.line,1);
  assert.equal(output.matches[0].captures[0].start.column,17);
  assert.ok(h.calls.some(c=>c.op==='matches' && c.options.matchLimit <= 256 && c.options.timeoutMicros > 0));
  assert.equal(h.counts().disposeCount,3,'query, tree, parser cleaned up');
});

test('captures named groups and initializes grammar lazily only once per language',async t=>{
  const h=setup(t);
  assert.equal(h.counts().initCount,0);
  const one=await h.broker.run(h.index,{path:'src/app.ts',mode:'capture',group:'functions'});
  assert.equal(one.mode,'capture');
  assert.ok(one.captures.some(c=>c.text==='sum'));
  assert.match(h.calls.find(c=>c.op==='query').source,/function_declaration/);
  const two=await h.broker.run(h.index,{path:'src/app.ts',mode:'capture',group:'functions'});
  assert.equal(two.captures.length,1);
  assert.deepEqual(h.counts(),{initCount:1,languageLoadCount:1,disposeCount:6});
});

test('enforces match, capture and node-text limits with honest truncation indicators',async t=>{
  const h=setup(t,{queryMatches:Array.from({length:40},(_,i)=>({patternIndex:i,captures:Array.from({length:15},(_,j)=>({name:'name',node:{type:'identifier',text:'Z'.repeat(400),startPosition:{row:i,column:j},endPosition:{row:i,column:j+2}}}))}))});
  const result=await h.broker.run(h.index,{path:'src/app.ts',query:'(identifier) @name',mode:'query',limit:3});
  assert.equal(result.matches.length,3);
  assert.ok(result.matches.every(m=>m.captures.length<=10));
  assert.ok(result.matches.every(m=>m.captures.every(c=>c.text.length<=201)));
  assert.equal(result.truncated,true);
  assert.equal(result.moreMatches,true);
  const captured=await h.broker.run(h.index,{path:'src/app.ts',mode:'capture',group:'identifiers',limit:4});
  assert.equal(captured.captures.length,4);
  assert.equal(captured.truncated,true);
});

test('rejects traversals, unindexed paths, symlinks, oversized sources and unsupported grammar',async t=>{
  const h=setup(t);
  writeFileSync(join(h.root,'private.ts'),'export const PASSWORD="hidden";\n');
  assert.rejects(()=>h.broker.run(h.index,{path:'../../secret.ts',query:'(identifier) @id'}),/outside project/i);
  assert.rejects(()=>h.broker.run(h.index,{path:'private.ts',query:'(identifier) @id'}),/indexed/i);
  symlinkSync(join(h.root,'src','app.ts'),join(h.root,'src','fake.ts'));
  assert.rejects(()=>h.broker.run(h.index,{path:'src/fake.ts',query:'(identifier) @id'}),/symlink|indexed/i);
  assert.rejects(()=>h.broker.run(h.index,{path:'src/app.ts',query:'X'.repeat(2500)}),/query.*limit/i);
  writeFileSync(join(h.root,'src','app.ts'),'x'.repeat(275_000));
  assert.rejects(()=>h.broker.run(h.index,{path:'src/app.ts',query:'(identifier) @id'}),/source.*limit/i);
  assert.equal(treeGrammarForPath('some/file.md'),null);
});

test('Python and Go queries are gated by the single existing multi-language index',async t=>{
  const h=setup(t);
  assert.rejects(()=>h.broker.run(h.index,{path:'src/tool.py',query:'(identifier) @name'}),/indexed|language/i);
  h.index.languagesEnabled=true;h.index.refresh();
  assert.ok(h.index.files.has('src/tool.py'));
  const result=await h.broker.run(h.index,{path:'src/tool.py',mode:'capture',group:'functions'});
  assert.equal(result.language,'python');
  assert.match(h.calls.find(c=>c.op==='query').source,/function_definition/);
});

test('empty results are distinguished from unavailable engine and saturated queries',async t=>{
  const h=setup(t,{queryMatches:[],exceeded:true});
  const result=await h.broker.run(h.index,{path:'src/app.ts',query:'(identifier) @name'});
  assert.equal(result.matches.length,0);
  assert.equal(result.truncated,true);
  const absent=new TreeSitterBroker({loadRuntime:async()=>{throw Error('npm package missing');}});
  const status=await absent.availability();
  assert.equal(status.available,false);
  assert.match(status.reason,/npm package missing/i);
  await assert.rejects(()=>absent.run(h.index,{path:'src/app.ts',query:'(identifier) @name'}),/tree-sitter.*unavailable/i);
});

test('capture presets are scoped and unknown groups are rejected without executing a parser',async t=>{
  const h=setup(t);
  assert.match(namedTreeQuery('go','functions'),/function_declaration/);
  assert.match(namedTreeQuery('python','classes'),/class_definition/);
  assert.equal(treeGrammarForPath('app.tsx'),'tsx');
  await assert.rejects(()=>h.broker.run(h.index,{path:'src/app.ts',mode:'capture',group:'commands'}),/unsupported.*capture/i);
  assert.equal(h.counts().initCount,0);
});

test('does not accept inherited object properties as capture group names',async t=>{
  const h=setup(t);
  await assert.rejects(()=>h.broker.run(h.index,{path:'src/app.ts',mode:'capture',group:'__proto__'}),/unsupported.*capture/i);
  assert.equal(h.counts().initCount,0);
});

test('global model-visible capture payload has a hard output byte budget',async t=>{
  const h=setup(t,{queryMatches:Array.from({length:25},(_,i)=>({patternIndex:i,
    captures:Array.from({length:10},(_,j)=>({name:'capture',node:{type:'identifier',text:'A'.repeat(200),
      startPosition:{row:i,column:j},endPosition:{row:i,column:j+2}}}))}))});
  const response=await h.broker.run(h.index,{path:'src/app.ts',query:'(identifier) @capture',limit:25});
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 16_000,`response ${Buffer.byteLength(JSON.stringify(response))} bytes`);
  assert.equal(response.truncated,true);
});

test('supports real Web Tree-sitter boolean node.hasError property (not only test-double methods)',async t=>{
  const h=setup(t);
  const fake=h.broker.loadRuntime;
  h.broker.loadRuntime=async()=>{
    const impl=await fake();
    const OldParser=impl.Parser;
    class Parser extends OldParser {
      parse(source){
        const tree=super.parse(source);
        tree.rootNode.hasError=true;
        return tree;
      }
    }
    return {...impl,Parser};
  };
  const report=await h.broker.run(h.index,{path:'src/app.ts',query:'(identifier) @name'});
  assert.equal(report.hasSyntaxErrors,true);
});

test('capture mode uses Tree-sitter native source-ordered captures instead of grouped query order',async t=>{
  const h=setup(t,{queryMatches:[{patternIndex:0,captures:[{name:'late',node:{type:'identifier',text:'late',startPosition:{row:5,column:0},endPosition:{row:5,column:4}}}]}]});
  const original=h.broker.loadRuntime;
  h.broker.loadRuntime=async()=>{
    const impl=await original();
    class Query extends impl.Query {
      captures(root,options){
        return [
          {name:'first',node:{type:'identifier',text:'first',startPosition:{row:0,column:0},endPosition:{row:0,column:5}}},
          {name:'second',node:{type:'identifier',text:'second',startPosition:{row:2,column:0},endPosition:{row:2,column:6}}}
        ];
      }
    }
    return {...impl,Query};
  };
  const result=await h.broker.run(h.index,{path:'src/app.ts',mode:'capture',group:'identifiers'});
  assert.deepEqual(result.captures.map(x=>x.text),['first','second']);
});
