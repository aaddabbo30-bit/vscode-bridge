(function () {
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const q = document.getElementById('q');
  const sel = document.getElementById('sel');
  const file = document.getElementById('file');
  let state = { messages: [] };
  let lastCount = -1;
  const codeStore = [];

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    // s is already escaped
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 <span style="opacity:.7">($2)</span>');
  }

  function md(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let i = 0;
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) { html += '<p>' + inline(esc(para.join('\n'))).replace(/\n/g, '<br>') + '</p>'; para = []; } };
    const flushList = () => { if (list) { html += `<${list.t}>` + list.items.map((x) => '<li>' + inline(esc(x)) + '</li>').join('') + `</${list.t}>`; list = null; } };
    while (i < lines.length) {
      const l = lines[i];
      const fence = l.match(/^\s*```\s*([\w+#.-]*)/);
      if (fence) {
        flushPara(); flushList();
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        const idx = codeStore.push(buf.join('\n')) - 1;
        html += `<div class="code"><div class="bar"><span>${esc(lang)}</span><button data-act="copy" data-code="${idx}">Copia</button><button data-act="insert" data-code="${idx}" title="Inserisci al cursore / sostituisci la selezione">Inserisci</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`;
        continue;
      }
      const h = l.match(/^(#{1,6})\s+(.*)/);
      const ul = l.match(/^\s*[-*+]\s+(.*)/);
      const ol = l.match(/^\s*\d+[.)]\s+(.*)/);
      if (h) { flushPara(); flushList(); html += '<h4>' + inline(esc(h[2])) + '</h4>'; }
      else if (ul || ol) {
        flushPara();
        const t = ul ? 'ul' : 'ol';
        if (!list || list.t !== t) { flushList(); list = { t, items: [] }; }
        list.items.push((ul || ol)[1]);
      } else if (!l.trim()) { flushPara(); flushList(); }
      else if (list && /^\s{2,}\S/.test(l)) { list.items[list.items.length - 1] += ' ' + l.trim(); }
      else { flushList(); para.push(l); }
      i++;
    }
    flushPara(); flushList();
    return html;
  }

  function renderStatus() {
    let dot = 'off'; let txt = '';
    if (!state.hasToken || state.conn === 'unconfigured') { txt = 'Da configurare'; }
    else if (state.conn === 'offline') { txt = 'Server non raggiungibile: ' + (state.connError || ''); }
    else if (state.listening) { dot = 'on'; txt = 'Claude in ascolto'; }
    else { dot = 'warn'; txt = 'Collegato, ma nessuna chat Claude in ascolto'; }
    let btns = '';
    if (!state.hasToken || state.conn !== 'online') btns += '<button class="link" data-act="configure">Configura</button>';
    else if (!state.listening) btns += '<button class="link" data-act="copyPrompt">Copia prompt per claude.ai</button>';
    btns += ' <button class="link" data-act="clear" title="Pulisci la chat">Pulisci</button>';
    statusEl.innerHTML = `<span class="dot ${dot}"></span><span class="grow">${esc(txt)}</span>${btns}`;
  }

  const cmdState = { auto: 'eseguito senza chiedere', asking: 'in attesa della tua approvazione', running: 'in esecuzione', done: 'completato', failed: 'terminato con errore', denied: 'rifiutato da te' };
  const editState = { pending: '', accepted: '✓ accettata e salvata', rejected: '✗ rifiutata', expired: 'scaduta (VS Code è stato riavviato)' };

  function renderMsg(m, isLastUser) {
    if (m.role === 'user') {
      let meta = m.sel ? 'con ' + esc(m.sel) : '';
      if (m.kind === 'edit') meta = 'modifica · ' + meta;
      let st = '';
      if (m.state === 'sending') st = '<div class="working">invio</div>';
      else if (m.state === 'error') st = `<div class="meta">⚠ non inviata: ${esc(m.error || '')}</div>`;
      else if (m.state === 'sent' && isLastUser) st = '<div class="working">in coda per Claude</div>';
      else if (m.state === 'working') st = '<div class="working">Claude sta lavorando</div>';
      return `<div class="msg user"><div class="who">Tu</div><div class="body">${esc(m.text)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}${st}</div>`;
    }
    if (m.role === 'claude') return `<div class="msg claude"><div class="who">Claude</div><div class="body">${md(m.text)}</div></div>`;
    if (m.role === 'edit') {
      const acts = m.state === 'pending'
        ? `<div class="acts"><button data-act="accept" data-id="${esc(m.editId)}">Accetta</button><button class="sec" data-act="reject" data-id="${esc(m.editId)}">Rifiuta</button><button class="sec" data-act="diff" data-id="${esc(m.editId)}">Vedi diff</button></div>`
        : `<div class="acts">${esc(editState[m.state] || m.state)}</div>`;
      return `<div class="msg edit"><div class="who">Proposta di modifica · ${esc(m.path)}</div>${esc(m.desc || '')}${acts}</div>`;
    }
    if (m.role === 'cmd') return `<div class="msg cmd">Comando: <code>${esc(m.text)}</code> — ${esc(cmdState[m.state] || m.state)}</div>`;
    return `<div class="msg system">${esc(m.text)}${m.prompt ? ' <button class="link" data-act="copyPrompt">Copia prompt</button>' : ''}</div>`;
  }

  function render() {
    renderStatus();
    codeStore.length = 0;
    const ms = state.messages || [];
    if (!ms.length) {
      log.innerHTML = `<div class="empty"><strong>Come si usa</strong><br>1. In claude.ai attiva il connector <em>VS Code Bridge</em> e scrivi «segui VS Code» (o usa “Copia prompt”).<br>2. Scrivi qui, oppure seleziona codice e premi <code>Ctrl+Alt+C</code> (domanda) o <code>Ctrl+Alt+E</code> (modifica).<br>3. Le modifiche arrivano come diff: Accetta o Rifiuta.</div>`;
    } else {
      const lastUserIdx = ms.map((m) => m.role).lastIndexOf('user');
      log.innerHTML = ms.map((m, i) => renderMsg(m, i === lastUserIdx)).join('');
    }
    if (ms.length !== lastCount) { log.scrollTop = log.scrollHeight; lastCount = ms.length; }
  }

  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'copy' || act === 'insert') vscode.postMessage({ type: act, text: codeStore[Number(b.dataset.code)] });
    else if (act === 'accept' || act === 'reject' || act === 'diff') vscode.postMessage({ type: act, editId: b.dataset.id });
    else vscode.postMessage({ type: act });
  });

  function send() {
    const text = q.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text, sel: sel.checked, file: file.checked });
    q.value = '';
  }
  document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') { state = e.data; render(); }
  });
  vscode.postMessage({ type: 'ready' });
})();
