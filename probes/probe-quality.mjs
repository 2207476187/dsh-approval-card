import { pathToFileURL } from 'node:url'
const DSH = (process.env.DSH_HOME ?? `${(process.env.USERPROFILE ?? '').replace(/\\/g, '/')}/.dsh`).replace(/\\/g, '/')
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const { applySummaryText } = await import(pathToFileURL(`${DSH}/profiles/desktop/plugins/dsh-approval-card/src/text.mjs`).href)
const buf = readFileSync(process.argv[2])
const magic=[0x28,0xb5,0x2f,0xfd]; const offs=[]
for (let i=0;i+3<buf.length;i+=1) if (buf[i]===magic[0]&&buf[i+1]===magic[1]&&buf[i+2]===magic[2]&&buf[i+3]===magic[3]) offs.push(i)
const chunks=[]
for (let k=0;k<offs.length;k+=1){ const a=offs[k], b=k+1<offs.length?offs[k+1]:buf.length
	try{ chunks.push(zstdDecompressSync(buf.subarray(a,b)).toString('utf8')) }catch{} }
const events=[]
for (const line of chunks.join('').split('\n')) { if(!line.trim()) continue; try{events.push(JSON.parse(line))}catch{} }
let cwd=''
for (const ev of events) if (ev.type==='session') cwd = ev.data?.header?.cwd ?? ev.data?.cwd ?? cwd
const argsById=new Map()
for (const ev of events){ if(ev.type!=='tool/call') continue; const d=ev.data??{}
	if(typeof d.callId!=='string') continue
	try{ argsById.set(d.callId, JSON.parse(d.arguments)) }catch{} }
const stats={total:0,noTarget:0,cwdTarget:0,onlyPath:0,started:0}
const samples=[]
for (const ev of events){
	if (ev.type!=='approval/asked') continue
	const d=ev.data??{}; stats.total+=1
	const req={toolName:d.toolName, callId:d.callId, reason:d.reason}
	const args=argsById.get(d.callId) ?? null
	const zh=applySummaryText(req,{args,argsSource:args?'callId':'none',cwd,env:process.env})
	if(!zh){stats.noTarget+=1; if(samples.length<4) samples.push(['NO-REWRITE',d.toolName,JSON.stringify(args).slice(0,110)]); continue}
	const head=zh.split(' \n')[0]
	const m=/^对\s+(.+?)\s+进行/.exec(head)
	const tgt=m?.[1]??''
	if(tgt===cwd || tgt===`当前工作目录 ${cwd}`){ stats.cwdTarget+=1; if(samples.length<8) samples.push(['CWD',d.toolName,head.slice(0,120)]) }
	if(/^命令行 /.test(tgt)) stats.onlyPath+=1
}
console.log(JSON.stringify(stats))
for (const s of samples) console.log(' -',s.join(' | '))
