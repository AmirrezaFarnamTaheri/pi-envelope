import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalGraphReader } from '../extensions/envelope/graphify-adapter.mjs';

function fixture(t, links, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'envelope-graph-direction-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  mkdirSync(join(root, 'graphify-out'));
  const graph = {
    directed: false,
    graph: {schema_version:'v8',graphify_version:'0.9.100'},
    nodes: [
      {id:'A',label:'Alpha',source_file:'src/a.ts'},
      {id:'B',label:'Beta',source_file:'src/b.ts'},
      {id:'C',label:'Gamma',source_file:'src/c.ts'}
    ], links
  };
  writeFileSync(join(root,'graphify-out','graph.json'),JSON.stringify(graph));
  if(options.stale)writeFileSync(join(root,'graphify-out','needs_update'),'1');
  const reader=new ExternalGraphReader(root);
  const index={root:realpathSync(root)};
  t.after(()=>reader.close());
  return {reader,index};
}

test('Graphify retained _src/_tgt markers override reordered NetworkX link endpoints',t=>{
  const {reader,index}=fixture(t,[
    {source:'A',target:'B',_src:'B',_tgt:'A',relation:'calls',confidence:'EXTRACTED'},
    {source:'B',target:'C',relation:'imports',confidence:'INFERRED'}
  ]);
  const fromB=reader.query(index,{action:'neighbors',source:'B',direction:'outgoing'});
  assert.deepEqual(fromB.neighbors.map(x=>x.id),['A','C']);
  assert.equal(fromB.neighbors[0].confidence,'EXTRACTED');
  assert.equal(fromB.neighbors[0].source,'B');
  assert.equal(fromB.neighbors[0].target,'A');
  assert.equal(fromB.neighbors[0].directionEvidence,'graphify-arc-markers');
  assert.deepEqual(reader.query(index,{action:'neighbors',source:'A',direction:'outgoing'}).neighbors,[]);
  assert.equal(reader.query(index,{action:'path',source:'B',target:'A',direction:'outgoing'}).found,true);
  assert.equal(reader.query(index,{action:'path',source:'A',target:'B',direction:'outgoing'}).found,false);
});

test('partial, inconsistent, or dangling direction markers cannot silently alter evidence',t=>{
  for(const bad of [
    {source:'A',target:'B',_src:'B',relation:'calls'},
    {source:'A',target:'B',_tgt:'A',relation:'calls'},
    {source:'A',target:'B',_src:'missing',_tgt:'A',relation:'calls'},
    {source:'A',target:'B',_src:4,_tgt:'A',relation:'calls'},
    {source:'A',target:'B',_src:'C',_tgt:'B',relation:'calls'}
  ]){
    const {reader,index}=fixture(t,[bad]);
    const status=reader.query(index,{action:'status'});
    assert.equal(status.state,'invalid',JSON.stringify(bad));
    assert.deepEqual(status.reasons,['graph-schema-invalid']);
  }
});

test('external node explanation shows bounded incoming/outgoing evidence and uncertainty',t=>{
  const {reader,index}=fixture(t,[
    {source:'A',target:'B',_src:'B',_tgt:'A',relation:'calls',confidence:'AMBIGUOUS'},
    {source:'B',target:'C',relation:'imports',confidence:'EXTRACTED'},
    {source:'C',target:'B',relation:'uses',confidence:'INFERRED'}
  ]);
  const report=reader.query(index,{action:'explain',source:'B',limit:1});
  assert.equal(report.node.id,'B');
  assert.equal(report.trust,'external-assertion-not-native-AST');
  assert.equal(report.complete,false);
  assert.equal(report.totalOutgoing,2);
  assert.equal(report.totalIncoming,1);
  assert.equal(report.truncated,true);
  assert.equal(report.outgoing.length,1);
  assert.equal(report.incoming.length,1);
  assert.equal(report.outgoing[0].confidence,'AMBIGUOUS');
  assert.equal(report.outgoing[0].source,'B');
  assert.equal(report.outgoing[0].target,'A');
});

test('explain refuses known-stale artifacts until explicitly acknowledged',t=>{
  const {reader,index}=fixture(t,[{source:'A',target:'B',relation:'imports'}],{stale:true});
  assert.throws(()=>reader.query(index,{action:'explain',source:'A'}),/stale/i);
  const report=reader.query(index,{action:'explain',source:'A',allowStale:true});
  assert.equal(report.state,'stale');
  assert.ok(report.reasons.includes('stale'));
});