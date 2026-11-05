const DSH = (process.env.DSH_HOME ?? `${(process.env.USERPROFILE ?? '').replace(/\\/g, '/')}/.dsh`).replace(/\\/g, '/')
import { readFileSync, readdirSync } from "node:fs"; import { join } from "node:path"; import { zstdDecompressSync } from "node:zlib"
const ROOT = `${DSH}/sessions/--D-DeepSeek~0020Harness~5DE5~4F5C~76EE~5F55-DeepSeek--`
function decode(f){const b=readFileSync(f);const fr=[];let s=0;for(let i=0;i+4<=b.length;i++){if(b[i]===0x28&&b[i+1]===0xb5&&b[i+2]===0x2f&&b[i+3]===0xfd){if(i>s)fr.push(b.subarray(s,i));s=i}}if(s<b.length)fr.push(b.subarray(s));const o=[];for(const x of fr){try{o.push(zstdDecompressSync(x).toString("utf8"))}catch{}}return o.join("")}
let best=null
for(const d of readdirSync(ROOT,{withFileTypes:true}).filter(x=>x.isDirectory())){try{const t=decode(join(ROOT,d.name,"session.v4.jsonl.zstd"));if(!best||t.length>best.length)best=t}catch{}}
const ev=[];for(const l of best.split("\n")){if(l.trim())try{ev.push(JSON.parse(l))}catch{}}
const m=new Map()
for(const e of ev) if(e.type==="approval/asked"){const c=e.data?.callId;m.set(c,(m.get(c)??0)+1)}
const dup=[...m.entries()].filter(([,v])=>v>1)
console.log("asked 总条数:", [...m.values()].reduce((a,b)=>a+b,0), " 不同 callId:", m.size, " 重复审批的 callId:", dup.length)
