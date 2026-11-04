import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { trimDownstreamReason } from 'file:///C:/Users/Administrator/.dsh/profiles/desktop/plugins/dsh-approval-card/src/text.mjs'
const buf = readFileSync(process.argv[2])
const M = Buffer.from([0x28,0xb5,0x2f,0xfd]); const at=[]
for (let i=0;i+4<=buf.length;i+=1) if (buf.compare(M,0,4,i,i+4)===0) at.push(i)
const ch=[]; for (let k=0;k<at.length;k+=1) { try { ch.push(zstdDecompressSync(buf.subarray(at[k], k+1<at.length?at[k+1]:buf.length))) } catch {} }
const events=[]; for (const l of Buffer.concat(ch).toString('utf8').split('\n')) { const t=l.trim(); if(!t.startsWith('{'))continue; try{events.push(JSON.parse(t))}catch{} }
const raw = { '命令：':0, '权限：':0, '原因：':0, '影响：':0, '目标：':0, '拦截：':0 }
let n=0
for (const ev of events) { const d=ev.data??ev; const ty=ev.type??d.type
  if (ty!=='approval/asked') continue
  n+=1
  const reason=String(d.reason??'')
  const zh=String(d.displayReason?.zh??'')
  const both=reason+'\n'+zh
  for (const k of Object.keys(raw)) if (both.includes(k)) raw[k]+=1
}
console.log(`asked=${n}`)
console.log('原始里出现该标签的条数:', JSON.stringify(raw))
// 抽一条带 影响 的看 trim 后还在不在
for (const ev of events) { const d=ev.data??ev; if ((ev.type??d.type)!=='approval/asked') continue
  const reason=String(d.reason??''); if (!reason.includes('影响：')) continue
  console.log('--- 原文 ---'); console.log(reason)
  console.log('--- trim 后 ---'); console.log(trimDownstreamReason(reason, 'D:\\x', 'D:\\DeepSeek Harness工作目录\\DeepSeek'))
  break
}
