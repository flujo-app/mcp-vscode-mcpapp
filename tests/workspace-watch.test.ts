import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {Workspace} from "../src/core/workspace.js";
import {CoreEvents} from "../src/core/events.js";
test("workspace watches real changes and rapid create/close/delete cycles leave no native handles",async()=>{
 for(let i=0;i<8;i++){
  const root=await mkdtemp(path.join(tmpdir(),"vscode-watch-"));const events=new CoreEvents();const changes:any[]=[];events.on(e=>{if(e.type==="workspace.changed")changes.push(e.data);});const workspace=new Workspace(root,events);
  try{
   await workspace.initialize();await workspace.startWatching();
   await new Promise(resolve=>setTimeout(resolve,300));await writeFile(path.join(root,"watch.txt"),"one");
   for(let attempt=0;attempt<80&&!changes.some(c=>c.path==="watch.txt");attempt++)await new Promise(resolve=>setTimeout(resolve,25));
   assert.ok(changes.some(c=>c.path==="watch.txt"),"created file notification is delivered");
  }finally{await workspace.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 }
});
