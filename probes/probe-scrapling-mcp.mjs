import { spawn } from 'node:child_process';

const EXE = 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python314\\Scripts\\scrapling.exe';

const child = spawn(EXE, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let buf = '';
let stderr = '';
const seen = [];

child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      seen.push(msg);
      if (msg.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      }
      if (msg.id === 2) finish();
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function finish() {
  const init = seen.find((m) => m.id === 1);
  const list = seen.find((m) => m.id === 2);
  console.log('=== initialize ===');
  console.log(JSON.stringify(init?.result?.serverInfo ?? init, null, 2));
  console.log('protocolVersion:', init?.result?.protocolVersion);
  console.log('capabilities:', JSON.stringify(init?.result?.capabilities));
  console.log('\n=== tools/list ===');
  const tools = list?.result?.tools ?? [];
  console.log('工具数量:', tools.length);
  for (const t of tools) {
    const first = String(t.description ?? '').split('\n')[0].slice(0, 90);
    console.log(`- ${t.name}  ::  ${first}`);
  }
  child.kill();
  process.exit(0);
}

setTimeout(() => {
  console.log('超时：没有收到 tools/list');
  console.log('stderr:', stderr.slice(0, 1500));
  child.kill();
  process.exit(1);
}, 45000);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'dsh-probe', version: '0.0.0' },
  },
});
