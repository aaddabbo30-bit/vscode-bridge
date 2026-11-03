# VS Code Bridge

Claude (chat di claude.ai, piano incluso) dentro VS Code, senza API.

```
VS Code (estensione Claude Bridge) ──HTTPS──▶ Cloudflare Worker (questa repo, /server) ◀── connector MCP ── chat claude.ai
```

- `server/` — Cloudflare Worker + Durable Object. `/mcp/<TOKEN>` è il server MCP da aggiungere in claude.ai come custom connector; `/api/*` è usato dall'estensione (header `Authorization: Bearer <TOKEN>`).
- `extension/` — estensione VS Code: pannello chat, Ctrl+Alt+C (domanda), Ctrl+Alt+E (modifica selezione), diff Accetta/Rifiuta, comandi con approvazione.

## Deploy del server
Automatico: il repo è collegato a Cloudflare Workers Builds (root directory `server`), quindi ogni push su `main` pubblica il worker `vscode-bridge`. Il secret `BRIDGE_TOKEN` è impostato nel dashboard del worker (Settings → Variables and Secrets).

Deploy manuale (da un computer dove Node può eseguire programmi):
```
cd server
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put BRIDGE_TOKEN
```
Controllo: `https://<nome>.<subdominio>.workers.dev/health` → "VS Code Bridge: online".

## Connector in claude.ai
Custom connector, nome `VS Code Bridge`, URL `https://<worker>/mcp/<TOKEN>`.

## Estensione
Pacchetto pronto: [`dist/claude-bridge.vsix`](dist/claude-bridge.vsix). Per ricrearlo:
```
cd extension
npx @vscode/vsce package --allow-missing-repository --skip-license -o claude-bridge.vsix
```
VS Code → Extensions → … → Install from VSIX. Poi comando **Claude Bridge: Configura** (URL del worker + token).

## Uso
In claude.ai (connector attivo): «Segui VS Code con il connector VS Code Bridge: chiama follow_vscode in loop e rispondi alle mie richieste dentro VS Code, finché non premo Stop.» Poi si lavora solo in VS Code.

## Test locale del server
```
cd server
echo BRIDGE_TOKEN=testtoken123 > .dev.vars
npx wrangler dev --port 8799 --ip 127.0.0.1   # in un altro terminale
node e2e-test.mjs
```

## Tool MCP
follow_vscode, reply, get_editor_context, read_file, list_files, search, get_diagnostics, propose_edit, run_command, open_file, get_result.
