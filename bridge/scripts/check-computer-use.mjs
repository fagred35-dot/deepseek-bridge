// Проверка реального внешнего MCP-сервера computer-use-mcp.
// Только подключение и tools/list — инструменты НЕ вызываем (они управляют
// мышью и клавиатурой, это опасно на живой машине).
import { McpClient } from '../src/mcp-client.mjs';

const MAIN = process.argv[2];
if (!MAIN) {
  console.error('Укажи путь к computer-use-mcp/dist/main.js');
  process.exit(1);
}

const client = new McpClient({
  name: 'computer',
  transport: 'stdio',
  command: process.execPath,
  args: [MAIN],
});

const ok = await client.start();
if (!ok) {
  console.error('НЕ ПОДКЛЮЧИЛСЯ:', client.lastError);
  process.exit(1);
}

console.log('serverInfo:', JSON.stringify(client.serverInfo));
console.log('Инструментов:', client.tools.length);
for (const t of client.tools) {
  console.log('  -', t.name, '—', (t.description || '').slice(0, 100));
  const props = t.inputSchema && t.inputSchema.properties ? Object.keys(t.inputSchema.properties) : [];
  if (props.length) console.log('      параметры:', props.join(', '));
}

client.stop();
