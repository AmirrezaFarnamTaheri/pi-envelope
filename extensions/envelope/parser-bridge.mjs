/** Optional local Python/Go structural AST parsing. Never executes indexed source. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT=fileURLToPath(new URL('../../scripts/',import.meta.url));
const DEFAULT_MAX_INPUT=3_000_000;
const DEFAULT_MAX_OUTPUT=3_000_000;
const VALID_PATH=(value)=>typeof value==='string' && value.length>=1 && value.length<=512
  && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/')
  && !value.split('/').some(x=>x===''||x==='.'||x==='..');

const nameField=(x)=>typeof x==='string'&&x.length>0&&x.length<=128;
const position=(x)=>Number.isSafeInteger(x)&&x>0&&x<=10_000_000;

/** Validate optional call evidence from external parser subprocesses before indexing. */
export function validateCallFacts(record){
  if(!record||typeof record!=='object'||Array.isArray(record))return false;
  if(record.declarations!==undefined&&(!Array.isArray(record.declarations)||record.declarations.length>2000||
    record.declarations.some(d=>!d||!nameField(d.name)||!position(d.line)||d.exported!==undefined&&typeof d.exported!=='boolean')))return false;
  if(record.bindings!==undefined&&(!Array.isArray(record.bindings)||record.bindings.length>1000||
    record.bindings.some(b=>!b||!['named','package','namespace'].includes(b.kind)||!nameField(b.local)||
      typeof b.spec!=='string'||b.spec.length>512||b.spec.includes('\0')||b.spec.startsWith('../')||
      b.kind==='named'&&!nameField(b.imported)||b.explicit!==undefined&&typeof b.explicit!=='boolean')))return false;
  if(record.calls!==undefined&&(!Array.isArray(record.calls)||record.calls.length>200||
    record.calls.some(c=>!c||!nameField(c.name)||!['direct','member'].includes(c.form)||
      typeof c.receiver!=='string'||c.receiver.length>128||!c.caller||!nameField(c.caller.name)||
      !position(c.caller.line)||!position(c.line)||!position(c.column)||typeof c.shadowed!=='boolean')))return false;
  if(record.omittedCalls!==undefined&&(!Number.isSafeInteger(record.omittedCalls)||record.omittedCalls<0||record.omittedCalls>10_000_000))return false;
  if(record.package!==undefined&&record.package!==null&&record.package!==''&&!nameField(record.package))return false;
  return true;
}

/** Source requests are carried exclusively in stdin, never command arguments or environment. */
export function parseLanguageBatch(language,files,options={}) {
  if(!['python','go'].includes(language))return {ok:false,reason:'unsupported parser language',records:[]};
  if(!Array.isArray(files)||files.length>1000||files.some(f=>!f||!VALID_PATH(f.path)||typeof f.content!=='string'))return {ok:false,reason:'invalid parser batch',records:[]};
  if(files.length===0)return {ok:true,records:[]};
  const input=JSON.stringify({files});
  const inputLimit=options.maxInputBytes??DEFAULT_MAX_INPUT;
  if(Buffer.byteLength(input)>inputLimit)return {ok:false,reason:'parser input limit exceeded',records:[]};
  const maxOutputBytes=options.maxOutputBytes??DEFAULT_MAX_OUTPUT;
  const command=language==='python'?options.pythonCommand||'python3':options.goCommand||'go';
  const argv=language==='python'?['-I','-S',join(ROOT,'py-ast-helper.py')]:['run',join(ROOT,'go-ast-helper.go')];
  let response;
  try {
    response=spawnSync(command,argv,{cwd:dirname(ROOT),input,encoding:'utf8',timeout:language==='go'?30_000:5000,
      maxBuffer:Math.max(1024,maxOutputBytes),shell:false,windowsHide:true,
      env:language==='go'?{...process.env,GOPROXY:'off',GOSUMDB:'off',GOTOOLCHAIN:'local',GOWORK:'off'}:process.env});
  }catch{return {ok:false,reason:'parser process did not start',records:[]};}
  if(response.error||response.status!==0||response.signal)return {ok:false,reason:response.error?.code||'parser unavailable or failed',records:[]};
  if(Buffer.byteLength(response.stdout||'')>maxOutputBytes)return {ok:false,reason:'parser output limit exceeded',records:[]};
  try{
    const decoded=JSON.parse(response.stdout);
    if(!Array.isArray(decoded.records)||decoded.records.length!==files.length)return {ok:false,reason:'invalid parser response',records:[]};
    for(let i=0;i<files.length;i++){
      const r=decoded.records[i];
      if(r?.path!==files[i].path||!Array.isArray(r.symbols)||!Array.isArray(r.imports)||!Array.isArray(r.diagnostics)||!validateCallFacts(r))return {ok:false,reason:'invalid parser record',records:[]};
    }
    return {ok:true,records:decoded.records};
  }catch{return {ok:false,reason:'invalid parser response JSON',records:[]};}
}
