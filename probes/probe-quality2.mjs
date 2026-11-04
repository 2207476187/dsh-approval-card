import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const { applySummaryText } = await import('file:///C:/Users/Administrator/.dsh/profiles/desktop/plugins/dsh-approval-card/src/text.mjs')
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
let n=0
for (const ev of events){
	if (ev.type!=='approval/asked') continue
	const d=ev.data??{}
	const args=argsById.get(d.callId) ?? null
	const zh=applySummaryText({toolName:d.toolName,callId:d.callId,reason:d.reason},{args,argsSource:args?'callId':'none',cwd,env:process.env})
	const head=zh.split(' \n')[0]
	if (head.includes('当前工作目录') || head.includes('命令行 ')) {
		n+=1
		console.log('---',n,d.toolName)
		console.log('HEAD:', head)
		console.log('ARGS:', JSON.stringify(args).slice(0,260))
	}
	if (n>=5) break
}
