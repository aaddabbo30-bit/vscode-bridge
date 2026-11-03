const B = 'http://127.0.0.1:8799';
const T = 'testtoken123';
let rid = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } else console.log('ok -', m); };

async function mcp(method, params, tok = T) {
  const r = await fetch(`${B}/mcp/${tok}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) });
  if (r.status !== 200) return { status: r.status };
  return r.json();
}
const tool = async (name, args) => { const r = await mcp('tools/call', { name, arguments: args }); return r.result.content[0].text; };
const api = async (method, p, body) => { const r = await fetch(B + p, { method, headers: { authorization: 'Bearer ' + T, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json() }; };

// fake extension: poll and answer jobs
const received = [];
let extOn = true;
async function extLoop() {
  while (true) {
    if (!extOn) { await new Promise((r) => setTimeout(r, 300)); continue; }
    const { j } = await api('GET', '/api/poll?wait=25');
    if (j.jobs.length) await api('POST', '/api/ack', { ids: j.jobs.map((x) => x.id) });
    for (const job of j.jobs) {
      received.push(job);
      if (job.type === 'read_file') await api('POST', '/api/result', { id: job.id, ok: true, result: 'src/a.py — 2 righe\n1| x=1\n2| y=2' });
      if (job.type === 'context') await api('POST', '/api/result', { id: job.id, ok: true, result: { os: 'Windows', workspace: [{ name: 'proj', path: 'C:\\proj' }], file: 'src/a.py', language: 'python', lines: 2, cursorLine: 1 } });
      if (job.type === 'propose_edit') await api('POST', '/api/result', { id: job.id, ok: false, error: 'edit 1: old_text non trovato' });
    }
  }
}

const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
assert(init.result.serverInfo.name === 'vscode-bridge' && init.result.instructions, 'initialize');
const notif = await fetch(`${B}/mcp/${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
assert(notif.status === 202, 'notification -> 202');
const tl = await mcp('tools/list', {});
assert(tl.result.tools.length === 11, 'tools/list has 11 tools');
assert((await mcp('tools/list', {}, 'wrong')).status === 404, 'wrong token on MCP -> 404');
assert((await fetch(B + '/api/poll', { headers: { authorization: 'Bearer nope' } })).status === 401, 'wrong token on API -> 401');

const p0 = await api('GET', '/api/poll?wait=0');
assert(p0.j.claudeListening === false, 'not listening at start');
extLoop();

// Claude starts following; request arrives 2s later
const t0 = Date.now();
const followP = tool('follow_vscode', {});
await new Promise((r) => setTimeout(r, 2000));
const rq = await api('POST', '/api/request', { kind: 'chat', text: 'Cosa fa questa funzione?', context: { os: 'Windows', workspace: [{ name: 'proj', path: 'C:\\proj' }], file: 'src/a.py', language: 'python', lines: 2, cursorLine: 1, selection: { startLine: 1, endLine: 2, text: 'x=1\ny=2' } } });
assert(rq.j.claudeListening === true, 'listening while follow_vscode waits');
const f1 = await followP;
console.log('---\n' + f1 + '\n---');
assert(f1.includes('Request #' + rq.j.seq) && f1.includes('x=1') && Date.now() - t0 < 6000, 'follow returns request quickly with context');
const cursor = Number(f1.match(/cursor: (\d+)/)[1]);

await new Promise((r) => setTimeout(r, 500));
assert(received.some((j) => j.type === 'status' && j.params.state === 'working'), 'ext got "working" status');
assert(received.some((j) => j.type === 'status' && j.params.listening === true), 'ext got "listening" status');

const rf = await tool('read_file', { path: 'src/a.py' });
assert(rf.includes('1| x=1'), 'read_file round trip');
const ctx = await tool('get_editor_context', {});
assert(ctx.includes('Active file: src/a.py'), 'get_editor_context formatted');
const pe = await mcp('tools/call', { name: 'propose_edit', arguments: { path: 'src/a.py', description: 'x', edits: [{ old_text: 'zzz', new_text: 'q' }] } });
assert(pe.result.isError && pe.result.content[0].text.includes('non trovato'), 'tool error propagated as isError');

// reply via follow + event comes back
const f2P = tool('follow_vscode', { cursor, reply: { request_id: rq.j.seq, text: 'Assegna **x** e y.' } });
await new Promise((r) => setTimeout(r, 800));
assert(received.some((j) => j.type === 'reply' && j.params.text.includes('Assegna')), 'ext got the reply');
await api('POST', '/api/event', { event: 'edit_result', data: { edit_id: 'e5', path: 'src/a.py', accepted: true } });
const f2 = await f2P;
assert(f2.includes('ACCEPTED'), 'event delivered to follow');
const c2 = Number(f2.match(/cursor: (\d+)/)[1]);

// timeout round
const t1 = Date.now();
const f3 = await tool('follow_vscode', { cursor: c2 });
assert(f3.includes('No new requests') && Date.now() - t1 > 24000, 'empty round waits ~25s');

// pending job + get_result
extOn = false;
await new Promise((r) => setTimeout(r, 26000)); // let the in-flight ext poll finish
const pend = await tool('read_file', { path: 'src/a.py' });
assert(pend.includes('Still pending') && pend.includes('get_result'), 'pending when ext does not answer');
const jobId = pend.match(/job_id "([^"]+)"/)[1];
extOn = true;
const gr = await tool('get_result', { job_id: jobId });
assert(gr.includes('1| x=1'), 'get_result returns late result');

// stop
const sP = tool('follow_vscode', { cursor: c2 });
await api('POST', '/api/request', { kind: 'stop', text: 'STOP' });
const s = await sP;
assert(s.includes('STOP') && s.includes('Do NOT call follow_vscode'), 'stop handled');
console.log('ALL OK');
process.exit(0);
