/** Bounded, offline real go/types package facts over SHA-verified indexed Go source. */
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const SHA=/^[0-9a-f]{64}$/;
const hash=b=>createHash('sha256').update(b).digest('hex');
const inside=(root,path)=>root===path||path.startsWith(root+sep);
const safeInt=(v,d,min,max,name)=>{v??=d;if(!Number.isInteger(v)||v<min||v>max)throw new RangeError(name+' must be '+min+'..'+max);return v;};
const helper=fileURLToPath(new URL('../../scripts/go-typechecker-helper.go',import.meta.url));
export function inspectGoTypes(index,{action='diagnostics',path,line,column,limit=15,maxChars=4000}={}) {
 if(!index?.files||!index.checkedPath||typeof index.root!=='string')throw new TypeError('CodeIndex required');
 if(!['diagnostics','symbol'].includes(action))throw new TypeError('invalid Go typechecker action');
 limit=safeInt(limit,15,1,30,'limit');maxChars=safeInt(maxChars,4000,900,16000,'maxChars');
 if(action==='symbol'){line=safeInt(line,undefined,1,100000,'line');column=safeInt(column,undefined,1,100000,'column');}
 const root=realpathSync(index.root);
 if(root!==index.root)throw new Error('project root changed');
 const selected=index.checkedPath(path),chosen=index.files.get(selected);
 if(!chosen||chosen.language!=='go'||!selected.endsWith('.go'))throw new Error('indexed Go source required');
 const directory=dirname(selected),includeTests=selected.endsWith('_test.go'),rows=[];let total=0;
 for(const [p,record] of [...index.files].sort(([a],[b])=>a.localeCompare(b))){
  // Never send foo and its external foo_test package into one go/types unit.
  if(record.language!=='go'||dirname(p)!==directory||record.package!==chosen.package||
    (!includeTests&&p.endsWith('_test.go')))continue;
  if(p!==index.checkedPath(p)||!SHA.test(record.contentSha256||''))throw new Error('unverified indexed Go source path');
  const absolute=resolve(root,p),st=lstatSync(absolute),canonical=realpathSync(absolute);
  if(!inside(root,absolute)||!inside(root,canonical)||st.isSymbolicLink()||!st.isFile())throw new Error('unsafe Go source symlink');
  total+=st.size;if(rows.length>=64||total>2_000_000)throw new RangeError('Go compiler source budget exceeded');
  const data=readFileSync(absolute);
  if(hash(data)!==record.contentSha256)throw new Error('Go source changed since CodeIndex refresh');
  rows.push({path:p,content:data.toString('utf8')});
 }
 const selectedFile=rows.find(x=>x.path===selected);
 if(!selectedFile)throw new Error('selected source not compiled or ignored');
 if(action==='symbol'){
  const lines=selectedFile.content.split(/\r?\n/);
  if(line>lines.length)throw new RangeError('Go cursor line outside file bounds');
  if(column>lines[line-1].length+1)throw new RangeError('Go cursor column outside file bounds');
 }
 const input=JSON.stringify({files:rows,path:selected,action,line,column,limit});
 if(Buffer.byteLength(input,'utf8')>2_400_000)throw new RangeError('Go compiler input too large');
 const result=spawnSync('go',['run',helper],{
  cwd:dirname(helper),input,encoding:'utf8',timeout:30000,maxBuffer:512_000,
  shell:false,windowsHide:true,env:{PATH:process.env.PATH||'',HOME:process.env.HOME||'',GOPROXY:'off',GOSUMDB:'off',GOWORK:'off',GO111MODULE:'off',GOTOOLCHAIN:'local',GOENV:'off'}
 });
 if(result.error||result.status!==0||result.signal)throw new Error('offline Go typechecker unavailable or failed');
 let facts;
 try{facts=JSON.parse(result.stdout);}catch{throw new Error('invalid offline Go typechecker response');}
 if(!facts||!['resolved','unresolved','diagnostics'].includes(facts.status)||typeof facts.complete!=='boolean'||!Number.isInteger(facts.errors)||facts.errors<0||
  !Array.isArray(facts.diagnostics)||facts.diagnostics.length>limit||!Array.isArray(facts.reasons)||facts.reasons.length>30||!Array.isArray(facts.declarations)||facts.declarations.length>20)
   throw new Error('malformed Go compiler facts');
 const version=hash(JSON.stringify(rows.map(r=>[r.path,index.files.get(r.path).contentSha256])));
 const output={mode:'go-compiler-evidence',provider:'Go standard go/types',action,path:selected,version,
  complete:facts.complete&&!index.lastRefresh?.unavailable?.length&&index.files.size<index.maxFiles,
  reasons:[...new Set([...facts.reasons,...(index.lastRefresh?.unavailable?.length?['parser-unavailable']:[]),...(index.files.size>=index.maxFiles?['index-file-cap-possibly-reached']:[])])],
  status:facts.status,errors:facts.errors,diagnostics:facts.diagnostics,
  ...(action==='symbol'?{symbol:facts.symbol??null,type:(facts.type??'').slice(0,240),declarations:facts.declarations}:{}),
  truncated:facts.truncated,
  notes:'Compiler-backed, offline go/types facts for indexed files within one Go package only. No project execution, external package download, cross-package/type-system proof or source-body output.'};
 if(Buffer.byteLength(JSON.stringify(output),'utf8')>maxChars)throw new RangeError('maxChars too small for compiler evidence');
 return output;
}
