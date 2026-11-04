import { buildSummaryLine, extractPaths, matchOperation } from 'file:///C:/Users/Administrator/.dsh/profiles/desktop/plugins/dsh-approval-card/src/text.mjs'

const WORK = 'D:\\DeepSeek Harness工作目录\\DeepSeek'
const cases = [
	`cd '${WORK}' && node ..\\audit.js --in C:\\tmp\\report.json`,
	`Set-Location 'C:\\Windows\\Temp'; Remove-Item 'C:\\Windows\\Temp\\a.txt'`,
	`cd ${WORK}; Get-Content 'C:\\Users\\Administrator\\.dsh\\sessions\\x.jsonl'`,
	`node audit.js --out C:\\tmp\\x.json`,
]
for (const command of cases) {
	const hit = matchOperation(command)
	console.log('CMD   ', command)
	console.log('  op  ', hit.operation, '| statement =', JSON.stringify(hit.statement))
	console.log('  paths=', JSON.stringify(extractPaths(hit.statement, 3)))
	console.log('  line=', buildSummaryLine({ toolName: 'pwsh', mode: '', args: { command }, cwd: WORK }))
}
