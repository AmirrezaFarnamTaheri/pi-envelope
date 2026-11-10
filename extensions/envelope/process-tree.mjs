/** Best-effort cleanup of trusted child processes and their descendants.
 * POSIX isolates each real subprocess into its own process group. Windows
 * requests taskkill /T /F. Neither is an OS sandbox.
 */
import {spawn} from 'node:child_process';
import {join} from 'node:path';
export function treeSpawnOptions(spawnProcess){
  return spawnProcess===spawn&&process.platform!=='win32'?{detached:true}:{};
}
export function terminateTree(child,signal,{spawnProcess=spawn}={}){
  const pid=child?.pid;
  if(spawnProcess===spawn&&Number.isInteger(pid)&&pid>0){
    if(process.platform==='win32'){
      const systemRoot=process.env.SystemRoot||process.env.SYSTEMROOT;
      const taskkill=systemRoot?join(systemRoot,'System32','taskkill.exe'):'taskkill.exe';
      try{
        const killer=spawn(taskkill,['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.on('error',()=>{try{child.kill(signal);}catch{}});
        killer.unref();return;
      }catch{/* try direct child */}
    }else{
      try{process.kill(-pid,signal);return;}catch{/* group already gone */}
    }
  }
  try{child?.kill(signal);}catch{/* already exited */}
}
