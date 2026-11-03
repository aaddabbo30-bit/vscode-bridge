// Claude Bridge — VS Code extension
// Talks only to the user's own VS Code Bridge server (HTTPS out). No API keys.
const vscode = require('vscode');
const path = require('path');
const cp = require('child_process');

const TOKEN_KEY = 'claudeBridge.token';
const EXCLUDE = '**/{node_modules,.git,.svn,.venv,venv,env,__pycache__,.mypy_cache,.pytest_cache,.ruff_cache,dist,build,out,.idea,.ipynb_checkpoints,.Rproj.user}/**';
const PROMPT = 'Segui VS Code con il connector VS Code Bridge: chiama follow_vscode in loop e rispondi alle mie richieste dentro VS Code, finché non premo Stop. Non scrivere in questa chat.';

let ctxExt;
let token = '';
let running = true;
let conn = 'unconfigured'; // unconfigured | online | offline
let connError = '';
let listening = false;
let lastActivity = Date.now();
let messages = []; // {id, role, text, requestId, state, editId, path, desc}
let panel; // ChatViewProvider
let statusItem;
let msgSeq = 0;
const proposals = new Map(); // editId -> proposal
const seenJobs = new Set();

// ---------------- activation ----------------
async function activate(context) {
  ctxExt = context;
  token = (await context.secrets.get(TOKEN_KEY)) || '';
  messages = context.workspaceState.get('claudeBridge.messages', []);
  msgSeq = messages.reduce((m, x) => Math.max(m, x.id || 0), 0);
  // a request left "in progress" from a previous session is no longer tracked
  messages.forEach((m) => {
    if (m.role === 'user' && m.state !== 'answered') m.state = 'old';
    if (m.role === 'edit' && m.state === 'pending') m.state = 'expired';
  });

  panel = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeBridge.chat', panel, { webviewOptions: { retainContextWhenHidden: true } }));

  const provider = new ProposalProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('claude-proposal', provider));
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('claude-empty', { provideTextDocumentContent: () => '' }));

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'workbench.view.extension.claudeBridge';
  context.subscriptions.push(statusItem);
  updateStatus();
  statusItem.show();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('claudeBridge.configure', configure);
  reg('claudeBridge.ask', () => askCommand('chat'));
  reg('claudeBridge.editSelection', () => askCommand('edit'));
  reg('claudeBridge.stop', () => sendRequest('stop', 'STOP', { includeSelection: false }));
  reg('claudeBridge.clear', () => { messages = []; persist(); });
  reg('claudeBridge.copyPrompt', async () => { await vscode.env.clipboard.writeText(PROMPT); vscode.window.showInformationMessage('Prompt copiato: incollalo in una chat di claude.ai con il connector VS Code Bridge attivo.'); });
  reg('claudeBridge.acceptEdit', (id) => acceptEdit(id));
  reg('claudeBridge.rejectEdit', (id) => rejectEdit(id));

  context.subscriptions.push({ dispose: () => { running = false; } });
  if (!token) {
    vscode.window.showInformationMessage('Claude Bridge: inserisci URL del server e token per iniziare.', 'Configura').then((c) => { if (c) configure(); });
  }
  pollLoop();
}

function deactivate() { running = false; }

// ---------------- config & http ----------------
function cfg() { return vscode.workspace.getConfiguration('claudeBridge'); }
function serverUrl() { return String(cfg().get('serverUrl') || '').replace(/\/+$/, ''); }

async function configure() {
  const url = await vscode.window.showInputBox({ title: 'Claude Bridge (1/2)', prompt: 'Indirizzo del server VS Code Bridge', value: serverUrl(), ignoreFocusOut: true });
  if (url === undefined) return;
  await cfg().update('serverUrl', url.trim().replace(/\/+$/, ''), vscode.ConfigurationTarget.Global);
  const t = await vscode.window.showInputBox({ title: 'Claude Bridge (2/2)', prompt: 'Token (lo stesso del secret BRIDGE_TOKEN sul server)', password: true, value: token, ignoreFocusOut: true });
  if (t === undefined) return;
  token = t.trim();
  await ctxExt.secrets.store(TOKEN_KEY, token);
  try {
    const r = await api('GET', '/api/poll?wait=0', null, 15000);
    conn = 'online'; listening = !!r.claudeListening; connError = '';
    vscode.window.showInformationMessage('Claude Bridge: collegato al server.');
  } catch (e) {
    conn = 'offline'; connError = e.message;
    vscode.window.showErrorMessage('Claude Bridge: non riesco a collegarmi — ' + e.message);
  }
  refresh();
}

function api(method, p, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(serverUrl() + p); } catch (e) { return reject(new Error('URL del server non valido')); }
    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = lib.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401) return reject(new Error('token sbagliato (401)'));
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + t.slice(0, 200)));
        try { resolve(t ? JSON.parse(t) : {}); } catch { reject(new Error('risposta non valida: ' + t.slice(0, 120))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollLoop() {
  while (running) {
    if (!token || !serverUrl()) { conn = 'unconfigured'; updateStatus(); await sleep(3000); continue; }
    const idleMs = Number(cfg().get('idleMinutes') || 20) * 60000;
    const fast = listening || Date.now() - lastActivity < idleMs;
    try {
      const r = await api('GET', '/api/poll?wait=' + (fast ? 25 : 0), null, 45000);
      const wasOnline = conn === 'online';
      conn = 'online'; connError = '';
      const l = !!r.claudeListening;
      if (l !== listening || !wasOnline) { listening = l; refresh(); }
      const fresh = (r.jobs || []).filter((j) => !seenJobs.has(j.id));
      if ((r.jobs || []).length) api('POST', '/api/ack', { ids: r.jobs.map((j) => j.id) }).catch(() => {});
      for (const j of fresh) { seenJobs.add(j.id); lastActivity = Date.now(); handleJob(j); }
      if (seenJobs.size > 2000) seenJobs.clear();
      if (!fast && !(r.jobs || []).length) await sleep(15000);
    } catch (e) {
      if (conn !== 'offline' || connError !== e.message) { conn = 'offline'; connError = e.message; refresh(); }
      await sleep(5000);
    }
  }
}

// ---------------- jobs from Claude ----------------
async function handleJob(j) {
  try {
    switch (j.type) {
      case 'reply': return onReply(j.params || {});
      case 'status': return onStatus(j.params || {});
    }
    const handlers = { context: () => buildContext({ selCap: 20000 }), read_file: readFileJob, list_files: listFilesJob, search: searchJob, get_diagnostics: diagnosticsJob, propose_edit: proposeEditJob, run_command: runCommandJob, open_file: openFileJob };
    const h = handlers[j.type];
    if (!h) throw new Error('Tipo sconosciuto: ' + j.type);
    const result = await h(j.params || {}, j);
    await api('POST', '/api/result', { id: j.id, ok: true, result });
  } catch (e) {
    try { await api('POST', '/api/result', { id: j.id, ok: false, error: String(e && e.message || e) }); } catch { /* offline */ }
  }
}

function onReply(p) {
  addMessage({ role: 'claude', text: String(p.text || ''), requestId: p.request_id ?? null });
  if (p.request_id != null && p.final !== false) setRequestState(p.request_id, 'answered');
}

function onStatus(p) {
  if (p.listening !== undefined) { listening = !!p.listening; refresh(); }
  if (p.request_id != null && p.state) setRequestState(p.request_id, p.state);
}

function setRequestState(id, state) {
  const m = messages.find((x) => x.role === 'user' && x.requestId === id);
  if (m && m.state !== 'answered') { m.state = state; persist(); }
}

// ---------------- paths ----------------
function folders() { return vscode.workspace.workspaceFolders || []; }

function resolvePath(p) {
  if (!p) throw new Error('path mancante');
  p = String(p).trim();
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) return vscode.Uri.file(p);
  const fs = folders();
  if (!fs.length) throw new Error('Nessuna cartella aperta in VS Code: usa un percorso assoluto.');
  const parts = p.replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  if (fs.length > 1) {
    const f = fs.find((x) => x.name === parts[0]);
    if (f) return vscode.Uri.joinPath(f.uri, ...parts.slice(1));
  }
  return vscode.Uri.joinPath(fs[0].uri, ...parts);
}

function rel(uri) {
  if (uri.scheme !== 'file') return uri.toString();
  return vscode.workspace.asRelativePath(uri, folders().length > 1);
}

function openDoc(uri) {
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
}

async function readText(uri) {
  const d = openDoc(uri);
  if (d) return { text: d.getText(), dirty: d.isDirty };
  const bytes = await vscode.workspace.fs.readFile(uri);
  return { text: Buffer.from(bytes).toString('utf8'), dirty: false };
}

async function exists(uri) {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

const cap = (s, n) => (s.length > n ? s.slice(0, n) + `\n… [troncato, ${s.length - n} caratteri in più]` : s);

function numbered(lines, start) {
  const w = String(start + lines.length).length;
  return lines.map((l, i) => String(start + i).padStart(w, ' ') + '| ' + l).join('\n');
}

function fmtDiag(d, uri) {
  const sev = ['error', 'warning', 'info', 'hint'][d.severity] || 'info';
  return `${uri ? rel(uri) + ':' : 'line '}${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}: ${d.message}${d.source ? ' (' + d.source + ')' : ''}`;
}

// ---------------- context ----------------
function buildContext(opts = {}) {
  const ctx = {
    os: process.platform === 'win32' ? 'Windows (commands run in cmd.exe)' : process.platform,
    workspace: folders().map((f) => ({ name: f.name, path: f.uri.fsPath })),
  };
  try {
    ctx.openTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .map((t) => (t.input && t.input.uri ? rel(t.input.uri) : t.label)).slice(0, 30);
  } catch { /* old VS Code */ }
  const ed = vscode.window.activeTextEditor;
  if (ed) {
    const d = ed.document;
    ctx.file = rel(d.uri);
    ctx.language = d.languageId;
    ctx.lines = d.lineCount;
    ctx.dirty = d.isDirty;
    ctx.cursorLine = ed.selection.active.line + 1;
    const vr = ed.visibleRanges[0];
    if (vr) ctx.visible = { startLine: vr.start.line + 1, endLine: vr.end.line + 1 };
    const s = ed.selection;
    if (opts.includeSelection !== false && !s.isEmpty) {
      ctx.selection = { startLine: s.start.line + 1, endLine: s.end.line + 1, text: cap(d.getText(s), opts.selCap || 30000) };
    }
    const diags = vscode.languages.getDiagnostics(d.uri)
      .filter((x) => x.severity <= vscode.DiagnosticSeverity.Warning).slice(0, 30);
    if (diags.length) ctx.diagnostics = diags.map((x) => fmtDiag(x));
    if (opts.includeFile) {
      const lines = d.getText().split(/\r?\n/);
      ctx.fileText = cap(numbered(lines.slice(0, 2000), 1), 90000) + (lines.length > 2000 ? `\n… [file lungo: ${lines.length} righe, usa read_file per il resto]` : '');
    }
  }
  return ctx;
}

// ---------------- tool handlers ----------------
async function readFileJob(p) {
  const uri = resolvePath(p.path);
  const { text, dirty } = await readText(uri);
  const lines = text.split(/\r?\n/);
  let start = Math.max(1, Number(p.start_line) || 1);
  let end = Math.min(lines.length, Number(p.end_line) || lines.length, start + 1499);
  const body = cap(numbered(lines.slice(start - 1, end), start), 120000);
  let head = `${rel(uri)} — ${lines.length} righe${dirty ? ' (modifiche non salvate incluse)' : ''}; mostrate ${start}-${end}`;
  if (end < lines.length) head += ` — continua con start_line=${end + 1}`;
  return head + '\n' + body;
}

async function listFilesJob(p) {
  const max = Math.min(Number(p.max) || 300, 2000);
  const files = await vscode.workspace.findFiles(p.glob || '**/*', EXCLUDE, max + 1);
  const list = files.map(rel).sort();
  const more = list.length > max;
  return `${Math.min(list.length, max)} file${more ? ' (lista troncata, usa un glob più preciso)' : ''}:\n` + list.slice(0, max).join('\n');
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function searchJob(p) {
  if (!p.query) throw new Error('query mancante');
  const max = Math.min(Number(p.max) || 150, 500);
  let re;
  try { re = new RegExp(p.regex ? p.query : escRe(p.query), p.case_sensitive ? '' : 'i'); } catch (e) { throw new Error('regex non valida: ' + e.message); }
  const files = await vscode.workspace.findFiles(p.glob || '**/*', EXCLUDE, 5000);
  const deadline = Date.now() + 20000;
  const out = [];
  let scanned = 0; let truncated = false;
  for (const f of files) {
    if (Date.now() > deadline) { truncated = true; break; }
    try {
      const d = openDoc(f);
      let text;
      if (d) text = d.getText();
      else {
        const st = await vscode.workspace.fs.stat(f);
        if (st.size > 1500000) continue;
        const bytes = await vscode.workspace.fs.readFile(f);
        if (bytes.subarray(0, 8000).includes(0)) continue;
        text = Buffer.from(bytes).toString('utf8');
      }
      scanned++;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${rel(f)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
          if (out.length >= max) { truncated = true; break; }
        }
      }
      if (out.length >= max) break;
    } catch { /* unreadable */ }
  }
  return `${out.length} risultati in ${scanned} file${truncated ? ' (troncato)' : ''}` + (out.length ? ':\n' + out.join('\n') : '.');
}

async function diagnosticsJob(p) {
  let pairs;
  if (p.path) { const u = resolvePath(p.path); pairs = [[u, vscode.languages.getDiagnostics(u)]]; }
  else pairs = vscode.languages.getDiagnostics();
  const lines = [];
  for (const [u, ds] of pairs) for (const d of ds) lines.push({ sev: d.severity, s: fmtDiag(d, u) });
  lines.sort((a, b) => a.sev - b.sev);
  if (!lines.length) return 'Nessun problema segnalato da VS Code' + (p.path ? ' per questo file.' : '.') + ' (VS Code segnala problemi solo per i file che il linter/language server ha analizzato.)';
  return `${lines.length} problemi:\n` + lines.slice(0, 300).map((x) => x.s).join('\n');
}

async function openFileJob(p) {
  const uri = resolvePath(p.path);
  const doc = await vscode.workspace.openTextDocument(uri);
  const line = Math.max(0, (Number(p.line) || 1) - 1);
  const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
  return `Aperto ${rel(uri)}${p.line ? ' alla riga ' + p.line : ''}.`;
}

// ---- propose_edit ----
class ProposalProvider {
  provideTextDocumentContent(uri) {
    const pr = proposals.get(uri.query);
    return pr ? pr.proposed : '';
  }
}

function applyEdits(text, edits) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/\n/g, eol);
  let out = text;
  edits.forEach((e, i) => {
    const oldT = norm(e.old_text);
    const newT = norm(e.new_text);
    if (!oldT) throw new Error(`edit ${i + 1}: old_text vuoto`);
    let count = 0; let idx = -1; let from = 0;
    while ((idx = out.indexOf(oldT, from)) !== -1) { count++; from = idx + oldT.length; if (count > 1) break; }
    if (count === 0) throw new Error(`edit ${i + 1}: old_text non trovato nel file (rileggilo con read_file e copialo esatto)`);
    if (count > 1) throw new Error(`edit ${i + 1}: old_text compare più volte, aggiungi righe intorno per renderlo unico`);
    const at = out.indexOf(oldT);
    out = out.slice(0, at) + newT + out.slice(at + oldT.length);
  });
  return out;
}

async function proposeEditJob(p, job) {
  const uri = resolvePath(p.path);
  const isNew = !(await exists(uri));
  let originalText = '';
  let proposed;
  if (isNew) {
    if (typeof p.new_content !== 'string') throw new Error('il file non esiste: per crearlo usa new_content');
    proposed = p.new_content;
  } else {
    originalText = (await readText(uri)).text;
    if (Array.isArray(p.edits) && p.edits.length) proposed = applyEdits(originalText, p.edits);
    else if (typeof p.new_content === 'string') {
      const eol = originalText.includes('\r\n') ? '\r\n' : '\n';
      proposed = p.new_content.replace(/\r\n/g, '\n').replace(/\n/g, eol);
    } else throw new Error('servono edits oppure new_content');
    if (proposed === originalText) throw new Error('la modifica non cambia niente nel file');
  }
  const editId = 'e' + job.id.replace(/^j/, '');
  const pr = { editId, uri, isNew, originalText, proposed, edits: Array.isArray(p.edits) && p.edits.length ? p.edits : null, desc: String(p.description || ''), status: 'pending', requestId: p.request_id ?? null };
  proposals.set(editId, pr);
  addMessage({ role: 'edit', editId, path: rel(uri), desc: pr.desc + (isNew ? ' (nuovo file)' : ''), state: 'pending' });
  await showDiff(editId);
  vscode.window.showInformationMessage(`Claude propone una modifica a ${path.basename(uri.fsPath)}: ${pr.desc}`, 'Accetta', 'Rifiuta').then((c) => {
    if (c === 'Accetta') acceptEdit(editId);
    else if (c === 'Rifiuta') rejectEdit(editId);
  });
  return `Diff shown to the user (edit id ${editId}, ${rel(uri)}). They will accept or reject it; the outcome arrives as an event in follow_vscode.`;
}

async function showDiff(editId) {
  const pr = proposals.get(editId);
  if (!pr) return;
  const right = vscode.Uri.from({ scheme: 'claude-proposal', path: '/' + path.basename(pr.uri.fsPath), query: editId });
  const left = pr.isNew ? vscode.Uri.from({ scheme: 'claude-empty', path: '/' + path.basename(pr.uri.fsPath) }) : pr.uri;
  await vscode.commands.executeCommand('vscode.diff', left, right, `Claude ↔ ${path.basename(pr.uri.fsPath)} (proposta ${editId})`, { preview: false });
}

function closeDiff(editId) {
  try {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === 'claude-proposal' && t.input.modified.query === editId);
    if (tabs.length) vscode.window.tabGroups.close(tabs);
  } catch { /* ignore */ }
}

async function acceptEdit(editId) {
  const pr = proposals.get(editId);
  if (!pr || pr.status !== 'pending') return;
  try {
    if (pr.isNew) {
      const parent = vscode.Uri.joinPath(pr.uri, '..');
      await vscode.workspace.fs.createDirectory(parent);
      await vscode.workspace.fs.writeFile(pr.uri, Buffer.from(pr.proposed, 'utf8'));
    } else {
      const doc = await vscode.workspace.openTextDocument(pr.uri);
      const current = doc.getText();
      let target = pr.proposed;
      if (current !== pr.originalText) {
        if (!pr.edits) throw new Error('il file è cambiato dopo la proposta');
        target = applyEdits(current, pr.edits);
      }
      const we = new vscode.WorkspaceEdit();
      we.replace(pr.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(current.length)), target);
      if (!(await vscode.workspace.applyEdit(we))) throw new Error('VS Code non ha applicato la modifica');
      await doc.save();
    }
    pr.status = 'accepted';
    closeDiff(editId);
    const d = await vscode.workspace.openTextDocument(pr.uri);
    await vscode.window.showTextDocument(d, { preview: false });
    finishEdit(pr, true);
  } catch (e) {
    vscode.window.showErrorMessage('Claude Bridge: modifica non applicata — ' + e.message);
  }
}

async function rejectEdit(editId) {
  const pr = proposals.get(editId);
  if (!pr || pr.status !== 'pending') return;
  const note = await vscode.window.showInputBox({ prompt: 'Vuoi dire a Claude perché? (facoltativo)', ignoreFocusOut: false });
  pr.status = 'rejected';
  closeDiff(editId);
  finishEdit(pr, false, note || '');
}

function finishEdit(pr, accepted, note = '') {
  const m = messages.find((x) => x.role === 'edit' && x.editId === pr.editId);
  if (m) m.state = accepted ? 'accepted' : 'rejected';
  persist();
  lastActivity = Date.now();
  api('POST', '/api/event', { event: 'edit_result', data: { edit_id: pr.editId, path: rel(pr.uri), accepted, note, request_id: pr.requestId } }).catch(() => {});
}

// ---- run_command ----
const META = /[&|;<>`$()\n\r%^]/;

async function runCommandJob(p) {
  const command = String(p.command || '').trim();
  if (!command) throw new Error('command mancante');
  const base = folders()[0] ? folders()[0].uri.fsPath : process.cwd();
  const cwd = p.cwd ? resolvePath(p.cwd).fsPath : base;
  const auto = (cfg().get('autoApproveCommands') || []).some((a) => (command === a || command.startsWith(a + ' '))) && !META.test(command);
  addMessage({ role: 'cmd', text: command, state: auto ? 'auto' : 'asking' });
  const msgRef = messages[messages.length - 1];
  if (!auto) {
    const choice = await vscode.window.showWarningMessage(
      'Claude vuole eseguire questo comando:', { modal: true, detail: `${command}\n\nCartella: ${cwd}${p.reason ? '\nMotivo: ' + p.reason : ''}` }, 'Esegui');
    if (choice !== 'Esegui') { msgRef.state = 'denied'; persist(); return 'The user did NOT allow this command. Ask them in your reply if it is needed, or do without it.'; }
  }
  msgRef.state = 'running'; persist();
  const timeout = Math.min(Number(p.timeout_seconds) || 120, 600) * 1000;
  const r = await new Promise((resolve) => {
    cp.exec(command, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, killed: !!(err && err.killed), stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
  msgRef.state = r.code === 0 ? 'done' : 'failed'; persist();
  const tail = (s, n) => (s.length > n ? `… [${s.length - n} caratteri iniziali omessi]\n` + s.slice(-n) : s);
  return `$ ${command}\n(cwd: ${cwd})\nexit code: ${r.code}${r.killed ? ' (interrotto per timeout)' : ''}\n--- stdout ---\n${tail(r.stdout, 15000) || '(vuoto)'}\n--- stderr ---\n${tail(r.stderr, 6000) || '(vuoto)'}`;
}

// ---------------- sending requests ----------------
async function askCommand(kind) {
  const ed = vscode.window.activeTextEditor;
  const hasSel = ed && !ed.selection.isEmpty;
  if (kind === 'edit' && !hasSel) { vscode.window.showWarningMessage('Seleziona prima il codice da modificare.'); return; }
  const text = await vscode.window.showInputBox({
    title: kind === 'edit' ? 'Modifica con Claude' : 'Chiedi a Claude',
    prompt: kind === 'edit' ? 'Come vuoi modificare la selezione?' : (hasSel ? 'Domanda sulla selezione' : 'Domanda (contesto: file attivo)'),
    ignoreFocusOut: true,
  });
  if (!text) return;
  vscode.commands.executeCommand('workbench.view.extension.claudeBridge');
  await sendRequest(kind, text, { includeSelection: true });
}

async function sendRequest(kind, text, opts = {}) {
  if (!token) { configure(); return; }
  lastActivity = Date.now();
  const context = kind === 'stop' ? null : buildContext(opts);
  const m = addMessage({ role: kind === 'stop' ? 'system' : 'user', text: kind === 'stop' ? 'Hai chiesto a Claude di smettere di seguire VS Code.' : text, kind, state: 'sending', sel: context && context.selection ? `${context.file}:${context.selection.startLine}-${context.selection.endLine}` : (opts.includeFile && context && context.file ? context.file + ' (intero)' : '') });
  try {
    const r = await api('POST', '/api/request', { kind, text, context }, 30000);
    m.requestId = r.seq;
    m.state = 'sent';
    if (!r.claudeListening && kind !== 'stop') {
      addMessage({ role: 'system', text: 'Nessuna chat Claude in ascolto. In claude.ai (connector VS Code Bridge attivo) scrivi «segui VS Code»: la richiesta resta in coda e verrà presa.', prompt: true });
    }
    persist();
  } catch (e) {
    m.state = 'error';
    m.error = e.message;
    persist();
  }
}

// ---------------- messages & UI ----------------
function addMessage(m) {
  m.id = ++msgSeq;
  m.at = Date.now();
  messages.push(m);
  if (messages.length > 200) messages = messages.slice(-200);
  persist();
  return m;
}

function persist() {
  ctxExt.workspaceState.update('claudeBridge.messages', messages);
  refresh();
}

function refresh() {
  updateStatus();
  if (panel) panel.post();
}

function updateStatus() {
  if (!statusItem) return;
  if (conn === 'unconfigured') { statusItem.text = '$(gear) Claude: da configurare'; statusItem.tooltip = 'Claude Bridge: Configura'; }
  else if (conn === 'offline') { statusItem.text = '$(debug-disconnect) Claude: offline'; statusItem.tooltip = connError; }
  else if (listening) { statusItem.text = '$(comment-discussion) Claude: in ascolto'; statusItem.tooltip = 'Una chat di claude.ai sta seguendo VS Code'; }
  else { statusItem.text = '$(comment) Claude: non in ascolto'; statusItem.tooltip = 'Scrivi «segui VS Code» in claude.ai'; }
}

class ChatViewProvider {
  constructor(extUri) { this.extUri = extUri; this.view = null; }
  resolveWebviewView(view) {
    this.view = view;
    const w = view.webview;
    w.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] };
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'panel.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'panel.css'));
    w.html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"></head>
<body><div id="status"></div><div id="log"></div>
<form id="f"><textarea id="q" rows="3" placeholder="Chiedi a Claude… (Invio per inviare, Shift+Invio per andare a capo)"></textarea>
<div class="row"><label><input type="checkbox" id="sel" checked> selezione</label><label><input type="checkbox" id="file"> file intero</label>
<span class="sp"></span><button type="button" id="stop" class="sec" title="Chiedi alla chat di smettere di seguire VS Code">Stop</button><button type="submit" id="send">Invia</button></div></form>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    w.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => { if (view.visible) this.post(); });
    this.post();
  }
  post() {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'state', conn, connError, listening, messages, prompt: PROMPT, hasToken: !!token });
  }
  async onMessage(m) {
    switch (m.type) {
      case 'ready': return this.post();
      case 'send': return sendRequest('chat', m.text, { includeSelection: m.sel, includeFile: m.file });
      case 'stop': return sendRequest('stop', 'STOP', {});
      case 'configure': return configure();
      case 'copy': await vscode.env.clipboard.writeText(m.text || ''); vscode.window.setStatusBarMessage('Copiato', 2000); return;
      case 'copyPrompt': await vscode.env.clipboard.writeText(PROMPT); vscode.window.showInformationMessage('Prompt copiato: incollalo nella chat di claude.ai.'); return;
      case 'insert': {
        const ed = vscode.window.visibleTextEditors.find((e) => e === vscode.window.activeTextEditor) || vscode.window.visibleTextEditors[0];
        if (!ed) { vscode.window.showWarningMessage('Apri un file in cui inserire il codice.'); return; }
        await ed.edit((b) => b.replace(ed.selection, m.text || ''));
        return;
      }
      case 'accept': return acceptEdit(m.editId);
      case 'reject': return rejectEdit(m.editId);
      case 'diff': return showDiff(m.editId);
      case 'clear': messages = []; return persist();
    }
  }
}

module.exports = { activate, deactivate };
