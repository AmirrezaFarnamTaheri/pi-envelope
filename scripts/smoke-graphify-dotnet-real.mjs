/** Genuine pinned Graphify.NET CLI AST-only smoke; no model or user project. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {GraphifyDotnetBridge} from '../extensions/envelope/graphify-dotnet-runtime.mjs';
export async function smokeRealGraphifyDotnet(executable){
 if(typeof executable!=='string'||!isAbsolute(executable))throw Error('absolute trusted .NET Graphify CLI required');
 const temp=mkdtempSync(join(tmpdir(),'envelope-real-graphify-dotnet-')),project=join(temp,'project');
 mkdirSync(project);const cli=new GraphifyDotnetBridge();
 try{
   writeFileSync(join(project,'Customer.cs'),
     'namespace Demo;\npublic class Customer { public int Id { get; set; } }\n'+
     'public static class CustomerService { public static Customer Create(int id) => new Customer { Id=id }; }\n');
   const config={enabled:true,executable,timeoutMs:120000};
   const before=await cli.run(project,config,{action:'status'});
   assert.equal(before.available,true,'pinned Graphify.NET executable unavailable');
   assert.equal(before.artifactState,'missing','fixture must start without graph');
   const done=await cli.run(project,config,{action:'build'},undefined,{humanCommand:true});
   assert.equal(done.artifactState,'unverified','Graphify.NET did not emit valid node-link JSON');
   assert.equal(done.artifactChanged,true,'AST-only run did not create new graph');
   assert.ok(done.nodes>0,'AST graph has no nodes');
   assert.ok(done.graphHash?.length===64,'missing graph checksum');
   const raw=JSON.parse(readFileSync(join(project,'.envelope','graphify-dotnet-out','graph.json'),'utf8'));
   assert.ok(Array.isArray(raw.nodes),'graph nodes missing');
   assert.ok(Array.isArray(raw.edges)||Array.isArray(raw.links),'graph edges missing');
   const declarations=raw.nodes.filter(node=>{
     const identity=String(node.label||node.name||node.id||'');
     const source=String(node.file_path||node.metadata?.source_file||'').replaceAll('\\','/');
     const declarationNode=node.type==='Entity'||/class|method|property|declaration/i.test(String(node.type||node.kind||''));
     return declarationNode&&/(^|[/])Customer[.]cs$/.test(source)&&
       /Customer|Create|Id/i.test(identity)&&Boolean(node.metadata?.source_location);
   });
   assert.ok(declarations.length>0,'C# Customer declaration evidence with source location missing from Graphify.NET AST graph');
   const after=await cli.run(project,config,{action:'status'});
   assert.equal(after.graphHash,done.graphHash,'status graph checksum changed unexpectedly');
   return {ok:true,provider:'None',nodes:done.nodes,edges:done.edges,isolatedOutput:true,engine:'graphify-dotnet',externalGraphProven:false};
 }finally{cli.close();rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]?.endsWith('smoke-graphify-dotnet-real.mjs')){
 try{console.log(JSON.stringify(await smokeRealGraphifyDotnet(process.argv[2])));}
 catch(err){console.error('Graphify.NET real smoke failed:',String(err?.message||'unknown').slice(0,200));process.exitCode=1;}
}
