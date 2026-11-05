import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from '../shared/io.mjs';

// Source-backed shared recall, without a second model, intent classifier or
// per-chat memory silo. Each immutable record is independently recoverable.
export class SharedMemory {
  constructor(directory) { this.directory=directory; this.entries=new Map(); this.sequence=0; this.writes=Promise.resolve(); }
  static async open(directory) {
    const memory=new SharedMemory(directory); await mkdir(directory,{recursive:true,mode:0o700});
    for (const name of await readdir(directory)) if (name.endsWith('.json')) {
      const entry=await readJson(resolve(directory,name));
      memory.entries.set(entry.id,entry); memory.sequence=Math.max(memory.sequence,entry.sequence);
    }
    return memory;
  }
  record(key,data) {
    const pending=this.writes.then(async()=>{
      const id=createHash('sha256').update(key).digest('hex');
      if(this.entries.has(id))return this.entries.get(id);
      const entry={...data,id,key,sequence:this.sequence+1,at:data.at??new Date().toISOString()};
      await writeJson(resolve(this.directory,`${id}.json`),entry);
      this.entries.set(id,entry); this.sequence=entry.sequence; return entry;
    });
    this.writes=pending.catch(()=>{}); return pending;
  }
  recent(limit=24) { return [...this.entries.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.sequence-b.sequence).slice(-limit); }
  after(sequence,limit=12) { return [...this.entries.values()].filter(x=>x.sequence>sequence).sort((a,b)=>a.sequence-b.sequence).slice(0,limit); }
  render(entries,source) {
    return entries.map(entry=>({ ...entry,
      currentConversation:Boolean(source&&entry.source?.chatid===source.chatid&&entry.source?.chattype===source.body?.chattype),
      text:entry.text?.slice(0,1400), truncated:(entry.text?.length??0)>1400,
      record:resolve(this.directory,`${entry.id}.json`) }));
  }
}
