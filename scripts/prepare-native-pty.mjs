// node-pty1.1.0 may ship its macOS spawn-helper without executable mode.
import {createRequire} from "node:module";
import {dirname,join} from "node:path";
import {lstat,chmod} from "node:fs/promises";
if(process.platform==="darwin"){
 const require=createRequire(import.meta.url);
 let root;try{root=dirname(require.resolve("node-pty/package.json"));}catch{}
 if(root)for(const dir of ["build/Release","build/Debug",`prebuilds/${process.platform}-${process.arch}`]){
  const helper=join(root,dir,"spawn-helper");let stat;try{stat=await lstat(helper);}catch(error){if(error.code==="ENOENT")continue;throw error;}
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Unexpected native PTY helper type.");
  if((stat.mode&0o111)!==0o111){await chmod(helper,stat.mode|0o111);console.error("Restored executable mode on the installed node-pty spawn-helper.");}
 }
}
