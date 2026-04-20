/**
 * Single-file web UI. All dynamic content is written via textContent / value
 * (never innerHTML), so there's no XSS surface. The CSP header restricts
 * script and style sources to 'self'.
 *
 * Layout is a 3-column CSS grid (rooms | main | members). Sidebars collapse
 * at narrow widths and can be toggled with the header buttons. Theme is
 * driven by a `data-theme` attribute on <html>; the default ('auto') follows
 * the OS `prefers-color-scheme`. The setting persists in localStorage.
 */
export const UI_HTML = `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>agentchat</title>
<style>
  /* ------- theme tokens ------- */
  :root {
    --bg:           #ffffff;
    --bg-elev:      #f7f7f8;
    --bg-sunken:    #ececed;
    --bg-hover:     rgba(0,0,0,.05);
    --bg-active:    rgba(0,0,0,.08);
    --border:       #e5e5e5;
    --border-strong:#d0d0d0;
    --text:         #0d0d0d;
    --text-dim:     #5d5d5d;
    --text-muted:   #8e8e8e;
    --accent:       #10a37f;
    --accent-fg:    #ffffff;
    --warn:         #d97706;
    --err:          #dc2626;
    --avatar-bg:    #d9e7e3;
    --code-bg:      #f0f0f0;
    --shadow:       0 1px 3px rgba(0,0,0,.04), 0 1px 2px rgba(0,0,0,.06);
    --shadow-lg:    0 10px 32px rgba(0,0,0,.12);
    color-scheme: light;
  }
  :root[data-theme="dark"], :root[data-theme="auto"] {
    color-scheme: dark light;
  }
  @media (prefers-color-scheme: dark) {
    :root[data-theme="auto"] {
      --bg:           #212121;
      --bg-elev:      #2f2f2f;
      --bg-sunken:    #171717;
      --bg-hover:     rgba(255,255,255,.06);
      --bg-active:    rgba(255,255,255,.10);
      --border:       #3a3a3a;
      --border-strong:#4a4a4a;
      --text:         #ececec;
      --text-dim:     #b4b4b4;
      --text-muted:   #868686;
      --accent:       #10a37f;
      --accent-fg:    #ffffff;
      --warn:         #f59e0b;
      --err:          #ef4444;
      --avatar-bg:    #3a4a45;
      --code-bg:      #2a2a2a;
      --shadow:       0 1px 3px rgba(0,0,0,.3), 0 1px 2px rgba(0,0,0,.4);
      --shadow-lg:    0 12px 36px rgba(0,0,0,.45);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --bg:           #212121;
    --bg-elev:      #2f2f2f;
    --bg-sunken:    #171717;
    --bg-hover:     rgba(255,255,255,.06);
    --bg-active:    rgba(255,255,255,.10);
    --border:       #3a3a3a;
    --border-strong:#4a4a4a;
    --text:         #ececec;
    --text-dim:     #b4b4b4;
    --text-muted:   #868686;
    --accent:       #10a37f;
    --accent-fg:    #ffffff;
    --warn:         #f59e0b;
    --err:          #ef4444;
    --avatar-bg:    #3a4a45;
    --code-bg:      #2a2a2a;
    --shadow:       0 1px 3px rgba(0,0,0,.3), 0 1px 2px rgba(0,0,0,.4);
    --shadow-lg:    0 12px 36px rgba(0,0,0,.45);
    color-scheme: dark;
  }

  /* ------- reset ------- */
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family:
      ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  button, input, textarea, select {
    font: inherit; color: inherit; margin: 0;
  }
  button { cursor: pointer; border: none; background: transparent; }
  button:focus-visible, input:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  a { color: var(--accent); text-decoration: none; }
  .hidden { display: none !important; }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0;
    margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0;
  }

  /* ------- scrollbar ------- */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 8px;
    border: 2px solid var(--bg);
  }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }

  /* ------- buttons ------- */
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    gap: 6px; padding: 7px 12px; border-radius: 6px;
    font-weight: 500; font-size: 13px;
    border: 1px solid var(--border);
    background: var(--bg-elev);
    color: var(--text);
    transition: background 120ms ease, border-color 120ms ease;
  }
  .btn:hover { background: var(--bg-hover); }
  .btn:active { background: var(--bg-active); }
  .btn.primary {
    background: var(--accent); border-color: var(--accent); color: var(--accent-fg);
  }
  .btn.primary:hover { filter: brightness(1.05); }
  .btn.primary:active { filter: brightness(.95); }
  .btn.danger { color: var(--err); border-color: var(--err); }
  .btn.ghost { border-color: transparent; background: transparent; }
  .btn.ghost:hover { background: var(--bg-hover); }
  .btn.icon { padding: 6px; border-radius: 6px; }
  .btn-svg { width: 18px; height: 18px; stroke-width: 2; }

  /* ------- inputs ------- */
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .field label { font-size: 12px; color: var(--text-dim); font-weight: 500; }
  input[type="text"], input[type="password"], textarea, select {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 6px;
    padding: 8px 10px;
    width: 100%;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--accent); }
  textarea { resize: none; }

  /* ------- app layout ------- */
  #app {
    display: grid;
    grid-template-columns: var(--sidebar-w, 280px) 1fr var(--aside-w, 260px);
    grid-template-rows: 100vh;
    height: 100vh;
  }
  #app.aside-collapsed { --aside-w: 0px; }
  #app.aside-collapsed #aside { display: none; }
  #app.sidebar-collapsed { --sidebar-w: 0px; }
  #app.sidebar-collapsed #sidebar { display: none; }

  /* sidebar */
  #sidebar {
    background: var(--bg-elev);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  .sidebar-head {
    padding: 12px;
    border-bottom: 1px solid var(--border);
    display: flex; gap: 8px; align-items: center;
  }
  .sidebar-head .brand {
    font-weight: 700; font-size: 15px; letter-spacing: -0.01em;
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sidebar-body { flex: 1; overflow-y: auto; padding: 8px; min-height: 0; }
  .sidebar-section { margin: 10px 4px 4px; font-size: 11px; color: var(--text-muted);
                     text-transform: uppercase; font-weight: 600; letter-spacing: .04em; }
  .room-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-radius: 6px; cursor: pointer; min-width: 0;
    transition: background 100ms ease;
  }
  .room-row:hover { background: var(--bg-hover); }
  .room-row.active { background: var(--bg-active); }
  .room-row .room-name {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 13.5px;
  }
  .room-row .badge {
    background: var(--warn); color: #fff; border-radius: 10px;
    padding: 1px 7px; font-size: 10.5px; font-weight: 600; line-height: 1.4;
  }
  .room-row .lock { color: var(--warn); font-size: 11px; flex-shrink: 0; }

  .sidebar-foot {
    padding: 10px; border-top: 1px solid var(--border);
    display: flex; gap: 8px; align-items: center;
    background: var(--bg-elev);
  }
  .sidebar-foot .me {
    flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px;
  }
  .sidebar-foot .me .nick {
    font-size: 13px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sidebar-foot .me .pub {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; color: var(--text-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* main */
  #main {
    display: grid;
    grid-template-rows: 56px 1fr auto;
    background: var(--bg);
    min-width: 0; min-height: 0;
    position: relative;
  }
  .topbar {
    display: flex; align-items: center; gap: 8px;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
    min-width: 0;
    background: var(--bg);
  }
  .topbar .title {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column; justify-content: center; gap: 1px;
  }
  .topbar .title .name { font-weight: 600; font-size: 15px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .topbar .title .topic {
    font-size: 12px; color: var(--text-dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .topbar .actions { display: flex; gap: 6px; align-items: center; }

  .messages {
    overflow-y: auto; padding: 16px 20px 8px;
    min-height: 0;
    scroll-behavior: smooth;
  }
  .messages .empty {
    margin-top: 20vh; text-align: center; color: var(--text-muted);
  }
  .msg {
    display: grid;
    grid-template-columns: 36px 1fr;
    gap: 12px;
    padding: 4px 0;
  }
  .msg + .msg.grouped { padding-top: 0; }
  .msg .avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: var(--avatar-bg);
    display: grid; place-items: center;
    font-weight: 600; font-size: 13px;
    color: var(--text);
    margin-top: 2px;
  }
  .msg.grouped .avatar { visibility: hidden; height: 0; margin: 0; }
  .msg .body { min-width: 0; }
  .msg .head {
    display: flex; gap: 8px; align-items: baseline;
    margin-bottom: 2px;
  }
  .msg .nick { font-weight: 600; font-size: 13.5px; }
  .msg .ts { font-size: 11px; color: var(--text-muted); }
  .msg .text {
    white-space: pre-wrap; overflow-wrap: anywhere;
    font-size: 14px; line-height: 1.55;
  }

  /* composer */
  .composer-wrap {
    padding: 10px 20px 18px;
    background: var(--bg);
    border-top: 1px solid transparent;
  }
  .composer {
    display: grid; grid-template-columns: 1fr auto;
    align-items: end; gap: 8px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 10px 12px 10px 14px;
    box-shadow: var(--shadow);
  }
  .composer:focus-within { border-color: var(--border-strong); }
  .composer textarea {
    background: transparent; border: none; padding: 0; resize: none;
    min-height: 22px; max-height: 220px;
    line-height: 1.5; font-size: 14px;
    width: 100%;
  }
  .composer textarea:focus { outline: none; }
  .send-btn {
    width: 32px; height: 32px; border-radius: 8px;
    background: var(--accent); color: var(--accent-fg);
    display: grid; place-items: center;
  }
  .send-btn:disabled {
    background: var(--bg-sunken); color: var(--text-muted); cursor: not-allowed;
  }
  .send-btn svg { width: 16px; height: 16px; }

  /* aside (members) */
  #aside {
    background: var(--bg-elev);
    border-left: 1px solid var(--border);
    display: flex; flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  .aside-head {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 8px;
  }
  .aside-head .label {
    flex: 1; font-weight: 600; font-size: 13px;
  }
  .aside-body { flex: 1; overflow-y: auto; padding: 12px; min-height: 0; }
  .aside-section {
    font-size: 11px; color: var(--text-muted);
    text-transform: uppercase; font-weight: 600; letter-spacing: .04em;
    margin: 8px 4px;
  }
  .member-row {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 6px; border-radius: 6px; min-width: 0;
  }
  .member-row .mini-avatar {
    width: 22px; height: 22px; border-radius: 50%;
    background: var(--avatar-bg); color: var(--text);
    display: grid; place-items: center;
    font-size: 11px; font-weight: 600;
    flex-shrink: 0;
  }
  .member-row .nick {
    flex: 1; min-width: 0; font-size: 13px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .member-row.you .nick { color: var(--accent); }

  .pending-card {
    border: 1px solid var(--warn);
    background: color-mix(in oklab, var(--warn) 10%, var(--bg-elev));
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 8px;
  }
  .pending-card .who { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
  .pending-card .pub {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; color: var(--text-dim);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-bottom: 8px;
  }
  .pending-card .btns { display: flex; gap: 6px; }
  .pending-card .btns .btn { padding: 5px 10px; font-size: 12px; flex: 1; }

  /* dialogs */
  dialog {
    background: var(--bg-elev);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px 22px;
    max-width: 520px;
    width: calc(100% - 32px);
    box-shadow: var(--shadow-lg);
  }
  dialog::backdrop { background: rgba(0,0,0,.55); backdrop-filter: blur(2px); }
  dialog h2 { margin: 0 0 14px; font-size: 18px; font-weight: 700; }
  dialog .actions {
    display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px;
  }
  .ticket-box {
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    word-break: break-all;
    user-select: all;
    max-height: 160px; overflow-y: auto;
  }
  .theme-row { display: flex; gap: 8px; }
  .theme-row .btn { flex: 1; }
  .theme-row .btn.active { border-color: var(--accent); }

  /* login */
  #login {
    min-height: 100vh;
    display: grid; place-items: center;
    padding: 20px;
  }
  #login .card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 28px 32px;
    max-width: 420px; width: 100%;
    box-shadow: var(--shadow);
  }
  #login h1 {
    margin: 0 0 6px; font-size: 22px; font-weight: 700;
  }
  #login p { margin: 0 0 16px; color: var(--text-dim); font-size: 13px; }

  /* toast */
  #toast-area {
    position: fixed; bottom: 20px; right: 20px;
    display: flex; flex-direction: column-reverse; gap: 8px;
    z-index: 1000;
    pointer-events: none;
  }
  .toast {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    box-shadow: var(--shadow-lg);
    min-width: 220px; max-width: 340px;
    pointer-events: auto;
    animation: toast-in 160ms ease-out;
  }
  .toast.err  { border-left-color: var(--err); }
  .toast.warn { border-left-color: var(--warn); }
  @keyframes toast-in {
    from { transform: translateY(6px); opacity: 0; }
    to   { transform: translateY(0);   opacity: 1; }
  }

  /* responsive */
  @media (max-width: 960px) {
    #app { grid-template-columns: 1fr; }
    #app #sidebar, #app #aside {
      position: fixed; top: 0; height: 100%;
      width: min(300px, 85vw);
      z-index: 40;
      transition: transform 180ms ease-out;
      box-shadow: var(--shadow-lg);
    }
    #app #sidebar { left: 0; transform: translateX(-100%); }
    #app #aside   { right: 0; transform: translateX(100%); }
    #app.sidebar-open #sidebar { transform: translateX(0); }
    #app.aside-open   #aside   { transform: translateX(0); }
    #app #sidebar, #app #aside { display: flex; }
    .backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,.4);
      z-index: 30; display: none;
    }
    #app.sidebar-open .backdrop, #app.aside-open .backdrop { display: block; }
    #app.sidebar-collapsed #sidebar { display: flex; }
    #app.aside-collapsed #aside { display: flex; }
    #app.sidebar-collapsed { --sidebar-w: 0; }
    #app.aside-collapsed { --aside-w: 0; }
  }
  @media (min-width: 961px) {
    .only-mobile { display: none !important; }
  }
</style>
</head>
<body>

<!-- login -->
<div id="login">
  <form id="login-form" class="card">
    <h1>agentchat</h1>
    <p>Paste your access token to sign in. You'll find it in the terminal
       where <code>agentchat-mcp</code> / <code>agentchat web</code> started,
       or at <code>~/.agentchat/web-token</code>.</p>
    <div class="field">
      <label for="token-input">Access token</label>
      <input id="token-input" type="password" autocomplete="off" spellcheck="false" placeholder="paste token">
    </div>
    <div class="actions"><button class="btn primary" type="submit">Unlock</button></div>
  </form>
</div>

<!-- app -->
<div id="app" class="hidden aside-collapsed">
  <div class="backdrop only-mobile" id="backdrop"></div>

  <!-- left sidebar -->
  <aside id="sidebar">
    <div class="sidebar-head">
      <span class="brand">agentchat</span>
      <button class="btn icon ghost" id="btn-new-room" title="New room">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button class="btn icon ghost" id="btn-join-room" title="Join by ticket">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
      </button>
    </div>
    <div class="sidebar-body">
      <div class="sidebar-section">Rooms</div>
      <div id="rooms-list"></div>
    </div>
    <div class="sidebar-foot">
      <div class="mini-avatar" id="me-avatar" style="width:28px;height:28px;font-size:12px;background:var(--avatar-bg);border-radius:50%;display:grid;place-items:center;font-weight:600;"></div>
      <div class="me">
        <div class="nick" id="me-nick"></div>
        <div class="pub" id="me-pub"></div>
      </div>
      <button class="btn icon ghost" id="btn-settings" title="Settings">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
      </button>
    </div>
  </aside>

  <!-- main -->
  <div id="main">
    <header class="topbar">
      <button class="btn icon ghost only-mobile" id="btn-sidebar" title="Rooms">
        <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
      <div class="title">
        <span class="name" id="room-name">Select a room</span>
        <span class="topic" id="room-topic"></span>
      </div>
      <div class="actions">
        <button class="btn" id="btn-invite" title="Copy invite ticket">Invite</button>
        <button class="btn ghost" id="btn-admission" title="Admission mode">Open</button>
        <button class="btn icon ghost" id="btn-aside" title="Members">
          <svg class="btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </button>
      </div>
    </header>

    <div class="messages" id="messages">
      <div class="empty" id="empty-state">
        <p>No room selected.</p>
        <p>Click <strong>+</strong> to create one, or paste a ticket to join.</p>
      </div>
    </div>

    <div class="composer-wrap" id="composer-wrap">
      <form class="composer" id="composer">
        <textarea id="input" rows="1" placeholder="Type a message…"></textarea>
        <button class="send-btn" type="submit" id="send-btn" disabled aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
        </button>
      </form>
    </div>
  </div>

  <!-- right sidebar -->
  <aside id="aside">
    <div class="aside-head">
      <span class="label">Members</span>
      <button class="btn icon ghost only-mobile" id="btn-aside-close" title="Close">✕</button>
    </div>
    <div class="aside-body">
      <div id="pending-area"></div>
      <div class="aside-section" id="members-header">Online</div>
      <div id="members-list"></div>
    </div>
  </aside>
</div>

<!-- dialogs -->
<dialog id="create-dialog">
  <h2>New room</h2>
  <div class="field">
    <label for="create-name">Name</label>
    <input id="create-name" type="text" placeholder="#general" autocomplete="off" spellcheck="false">
  </div>
  <div class="field">
    <label for="create-topic">Topic (optional)</label>
    <input id="create-topic" type="text" autocomplete="off">
  </div>
  <div class="field">
    <label for="create-admission">Admission</label>
    <select id="create-admission">
      <option value="open">Open — anyone with the ticket joins</option>
      <option value="approval">Approval — you approve each joiner</option>
    </select>
  </div>
  <div class="actions">
    <button type="button" class="btn" value="cancel">Cancel</button>
    <button type="button" class="btn primary" id="create-submit">Create</button>
  </div>
</dialog>

<dialog id="join-dialog">
  <h2>Join room</h2>
  <div class="field">
    <label for="join-ticket">Ticket</label>
    <textarea id="join-ticket" rows="5" placeholder="paste ticket…" spellcheck="false"></textarea>
  </div>
  <div class="actions">
    <button type="button" class="btn" value="cancel">Cancel</button>
    <button type="button" class="btn primary" id="join-submit">Join</button>
  </div>
</dialog>

<dialog id="invite-dialog">
  <h2>Invite ticket</h2>
  <p style="color:var(--text-dim);margin:0 0 10px;">Share this with the person you want to add.</p>
  <div class="ticket-box" id="invite-text"></div>
  <div class="actions">
    <button type="button" class="btn primary" id="copy-btn">Copy</button>
    <button type="button" class="btn" value="close">Close</button>
  </div>
</dialog>

<dialog id="settings-dialog">
  <h2>Settings</h2>
  <div class="field">
    <label for="nick-input">Nickname</label>
    <input id="nick-input" type="text" autocomplete="off" maxlength="32">
  </div>
  <div class="field">
    <label>Theme</label>
    <div class="theme-row" role="radiogroup" aria-label="Theme">
      <button type="button" class="btn" data-theme-set="auto" role="radio">Auto</button>
      <button type="button" class="btn" data-theme-set="light" role="radio">Light</button>
      <button type="button" class="btn" data-theme-set="dark" role="radio">Dark</button>
    </div>
  </div>
  <div class="actions">
    <button type="button" class="btn" value="close">Close</button>
    <button type="button" class="btn primary" id="nick-submit">Save nickname</button>
  </div>
</dialog>

<div id="toast-area" aria-live="polite"></div>

<script>
(function() {
  'use strict';

  // ------- theme -------
  const THEME_KEY = 'agentchat_theme';
  function applyTheme(t) {
    const v = (t === 'light' || t === 'dark') ? t : 'auto';
    document.documentElement.setAttribute('data-theme', v);
    localStorage.setItem(THEME_KEY, v);
    document.querySelectorAll('[data-theme-set]').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-theme-set') === v);
    });
  }
  applyTheme(localStorage.getItem(THEME_KEY) || 'auto');

  // ------- token bootstrap -------
  const TOKEN_KEY = 'agentchat_token';
  function bootstrapToken() {
    const m = /^#token=([0-9a-fA-F]{64})$/.exec(location.hash);
    if (m) {
      sessionStorage.setItem(TOKEN_KEY, m[1]);
      history.replaceState(null, '', location.pathname);
      return m[1];
    }
    return sessionStorage.getItem(TOKEN_KEY);
  }

  const $ = (id) => document.getElementById(id);
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ------- toast -------
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
    el.textContent = msg;
    $('toast-area').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 200ms, transform 200ms';
      el.style.opacity = '0'; el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 220);
    }, 3200);
  }

  // ------- state -------
  let token = bootstrapToken();
  let me = null;
  let rooms = [];
  let activeRoomId = null;
  let members = [];
  let messages = [];
  let pending = [];
  let ws = null;
  let wsBackoff = 800;

  // ------- api -------
  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Authorization': 'Bearer ' + token };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    opts.headers = Object.assign(headers, opts.headers || {});
    const res = await fetch(path, opts);
    if (res.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      location.reload();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // ------- login flow -------
  async function login() {
    try {
      me = await api('/api/me');
      $('login').classList.add('hidden');
      $('app').classList.remove('hidden');
      renderMe();
      await refreshRooms();
      openWs();
    } catch (e) {
      sessionStorage.removeItem(TOKEN_KEY);
      $('login').classList.remove('hidden');
      $('app').classList.add('hidden');
      if (e.message !== 'unauthorized') toast('Login failed: ' + e.message, 'err');
    }
  }

  function renderMe() {
    if (!me) return;
    $('me-nick').textContent = me.nickname || '(no nick)';
    $('me-pub').textContent = (me.pubkey || '').slice(0, 12) + '…';
    $('me-avatar').textContent = (me.nickname || '?').charAt(0).toUpperCase();
  }

  // ------- rooms -------
  async function refreshRooms() {
    const r = await api('/api/rooms');
    rooms = r.rooms || [];
    renderRooms();
    if (activeRoomId && !rooms.find((x) => x.id === activeRoomId)) activeRoomId = null;
    if (!activeRoomId && rooms.length > 0) await selectRoom(rooms[0].id);
    else await refreshActiveRoom();
  }

  function renderRooms() {
    const box = $('rooms-list'); box.textContent = '';
    if (rooms.length === 0) {
      const hint = document.createElement('div');
      hint.style.padding = '10px';
      hint.style.color = 'var(--text-muted)';
      hint.style.fontSize = '13px';
      hint.textContent = 'No rooms yet.';
      box.appendChild(hint);
      return;
    }
    for (const r of rooms) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'room-row' + (r.id === activeRoomId ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'room-name';
      name.textContent = r.name;
      row.appendChild(name);
      if (r.admission === 'approval') {
        const lock = document.createElement('span');
        lock.className = 'lock';
        lock.textContent = '●';
        lock.title = 'Approval-required room';
        row.appendChild(lock);
      }
      if (r.is_creator && r.pending_count > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(r.pending_count);
        badge.title = r.pending_count + ' pending';
        row.appendChild(badge);
      }
      row.addEventListener('click', () => selectRoom(r.id));
      box.appendChild(row);
    }
  }

  async function selectRoom(id) {
    activeRoomId = id;
    renderRooms();
    if (window.matchMedia('(max-width: 960px)').matches) {
      $('app').classList.remove('sidebar-open');
    }
    await refreshActiveRoom();
  }

  async function refreshActiveRoom() {
    const room = rooms.find((r) => r.id === activeRoomId);
    const app = $('app');
    if (!room) {
      $('room-name').textContent = 'Select a room';
      $('room-topic').textContent = '';
      $('btn-admission').textContent = '—';
      $('messages').textContent = '';
      $('messages').appendChild($('empty-state'));
      $('members-list').textContent = '';
      $('pending-area').textContent = '';
      $('composer-wrap').classList.add('hidden');
      app.classList.add('aside-collapsed');
      updateSendButton();
      return;
    }
    $('composer-wrap').classList.remove('hidden');
    $('room-name').textContent = '#' + room.name.replace(/^#/, '');
    $('room-topic').textContent = room.topic || '';
    $('btn-admission').textContent = room.admission === 'approval' ? 'Approval' : 'Open';
    $('btn-admission').classList.toggle('danger', room.admission === 'approval');

    const [memRes, msgRes, pendRes] = await Promise.all([
      api('/api/rooms/' + room.id + '/members'),
      api('/api/rooms/' + room.id + '/messages?limit=200'),
      room.is_creator ? api('/api/rooms/' + room.id + '/pending') : Promise.resolve({ pending: [] }),
    ]);
    members = memRes.members || [];
    messages = msgRes.messages || [];
    pending = pendRes.pending || [];
    renderMembers();
    renderMessages();
    renderPending();
    updateSendButton();
    scrollToBottom();
  }

  // ------- messages -------
  function isNearBottom(el, threshold) {
    return el.scrollHeight - (el.scrollTop + el.clientHeight) < (threshold || 80);
  }
  function scrollToBottom() {
    const el = $('messages');
    el.scrollTop = el.scrollHeight;
  }
  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_) { return ''; }
  }
  function shouldGroup(prev, cur) {
    if (!prev) return false;
    if (prev.sender !== cur.sender) return false;
    try {
      return (new Date(cur.ts) - new Date(prev.ts)) < 5 * 60 * 1000;
    } catch (_) { return false; }
  }
  function renderMessages() {
    const box = $('messages');
    box.textContent = '';
    if (messages.length === 0) {
      const e = document.createElement('div');
      e.className = 'empty';
      const p = document.createElement('p'); p.textContent = 'No messages yet. Say hi 👋';
      e.appendChild(p);
      box.appendChild(e);
      return;
    }
    let prev = null;
    for (const m of messages) {
      const grouped = shouldGroup(prev, m);
      const row = document.createElement('div');
      row.className = 'msg' + (grouped ? ' grouped' : '');
      const av = document.createElement('div');
      av.className = 'avatar';
      av.textContent = (m.nickname || '?').charAt(0).toUpperCase();
      const body = document.createElement('div'); body.className = 'body';
      if (!grouped) {
        const head = document.createElement('div'); head.className = 'head';
        const n = document.createElement('span'); n.className = 'nick';
        n.textContent = '@' + (m.nickname || m.sender.slice(0, 8));
        const t = document.createElement('span'); t.className = 'ts';
        t.textContent = fmtTime(m.ts);
        head.appendChild(n); head.appendChild(t);
        body.appendChild(head);
      }
      const text = document.createElement('div'); text.className = 'text';
      text.textContent = m.text;
      body.appendChild(text);
      row.appendChild(av); row.appendChild(body);
      box.appendChild(row);
      prev = m;
    }
  }

  // ------- members -------
  function renderMembers() {
    const box = $('members-list'); box.textContent = '';
    $('members-header').textContent = 'Members · ' + members.length;
    for (const m of members) {
      const row = document.createElement('div');
      row.className = 'member-row' + (me && m.pubkey === me.pubkey ? ' you' : '');
      const av = document.createElement('div'); av.className = 'mini-avatar';
      av.textContent = (m.nickname || '?').charAt(0).toUpperCase();
      const nick = document.createElement('span'); nick.className = 'nick';
      nick.textContent = '@' + (m.nickname || m.pubkey.slice(0, 8));
      row.appendChild(av); row.appendChild(nick);
      box.appendChild(row);
    }
  }

  function renderPending() {
    const box = $('pending-area'); box.textContent = '';
    if (pending.length === 0) return;
    const h = document.createElement('div');
    h.className = 'aside-section'; h.textContent = 'Pending · ' + pending.length;
    box.appendChild(h);
    for (const p of pending) {
      const card = document.createElement('div'); card.className = 'pending-card';
      const who = document.createElement('div'); who.className = 'who';
      who.textContent = '@' + p.nickname + ' wants to join';
      const pub = document.createElement('div'); pub.className = 'pub';
      pub.textContent = p.pubkey.slice(0, 24) + '…';
      const btns = document.createElement('div'); btns.className = 'btns';
      const a = document.createElement('button');
      a.type = 'button'; a.className = 'btn primary'; a.textContent = 'Approve';
      a.addEventListener('click', () => handleApproval(p.pubkey, 'approve'));
      const d = document.createElement('button');
      d.type = 'button'; d.className = 'btn danger'; d.textContent = 'Deny';
      d.addEventListener('click', () => handleApproval(p.pubkey, 'deny'));
      btns.appendChild(a); btns.appendChild(d);
      card.appendChild(who); card.appendChild(pub); card.appendChild(btns);
      box.appendChild(card);
    }
  }

  async function handleApproval(pubkey, action) {
    try {
      await api('/api/rooms/' + activeRoomId + '/pending/' + pubkey + '/' + action, { method: 'POST' });
      toast(action === 'approve' ? 'Approved.' : 'Denied.');
      await refreshRooms();
    } catch (e) { toast('Failed: ' + e.message, 'err'); }
  }

  // ------- composer -------
  function autosizeInput() {
    const ta = $('input');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
  }
  function updateSendButton() {
    const hasText = $('input').value.trim().length > 0;
    $('send-btn').disabled = !activeRoomId || !hasText;
  }
  async function send() {
    const ta = $('input');
    const text = ta.value.trim();
    if (!text || !activeRoomId) return;
    ta.value = ''; autosizeInput(); updateSendButton();
    try {
      await api('/api/rooms/' + activeRoomId + '/messages', {
        method: 'POST', body: JSON.stringify({ text }),
      });
    } catch (e) { toast('Send failed: ' + e.message, 'err'); }
  }

  // ------- websocket -------
  function openWs() {
    if (ws) { try { ws.close(); } catch (_) {} }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(token));
    ws.addEventListener('open', () => { wsBackoff = 800; });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === 'message' && msg.room_id === activeRoomId) {
        const near = isNearBottom($('messages'));
        messages.push(msg.payload);
        renderMessages();
        if (near) scrollToBottom();
      } else if (msg.type === 'message') {
        // TODO: unread badge for other rooms
      } else if (msg.type === 'join_request' ||
                 msg.type === 'member_joined' ||
                 msg.type === 'members_update' ||
                 msg.type === 'member_kicked') {
        refreshRooms();
      }
    });
    ws.addEventListener('close', () => {
      setTimeout(openWs, wsBackoff);
      wsBackoff = Math.min(wsBackoff * 2, 30000);
    });
    ws.addEventListener('error', () => {});
  }

  // ------- dialog helpers -------
  function openDialog(id) { $(id).showModal(); }
  qsa('dialog button[value]').forEach((b) => {
    b.addEventListener('click', (e) => { e.preventDefault(); b.closest('dialog').close(); });
  });

  // ------- wire events -------
  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('token-input').value.trim();
    if (!token) return;
    sessionStorage.setItem(TOKEN_KEY, token);
    login();
  });

  $('btn-new-room').addEventListener('click', () => {
    $('create-name').value = '#';
    $('create-topic').value = '';
    $('create-admission').value = 'open';
    openDialog('create-dialog');
    setTimeout(() => { const n = $('create-name'); n.focus(); n.setSelectionRange(1, 1); }, 0);
  });
  $('create-submit').addEventListener('click', async () => {
    const name = $('create-name').value.trim();
    if (!name) return;
    const topic = $('create-topic').value.trim();
    const admission = $('create-admission').value;
    try {
      const res = await api('/api/rooms', {
        method: 'POST', body: JSON.stringify({ name, topic, admission }),
      });
      $('create-dialog').close();
      await refreshRooms();
      await selectRoom(res.room.id);
      $('invite-text').textContent = res.ticket;
      openDialog('invite-dialog');
    } catch (e) { toast('Create failed: ' + e.message, 'err'); }
  });

  $('btn-join-room').addEventListener('click', () => {
    $('join-ticket').value = '';
    openDialog('join-dialog');
    setTimeout(() => $('join-ticket').focus(), 0);
  });
  $('join-submit').addEventListener('click', async () => {
    const ticket = $('join-ticket').value.trim();
    if (!ticket) return;
    try {
      const res = await api('/api/rooms/join', { method: 'POST', body: JSON.stringify({ ticket }) });
      $('join-dialog').close();
      await refreshRooms();
      await selectRoom(res.room.id);
    } catch (e) { toast('Join failed: ' + e.message, 'err'); }
  });

  $('btn-invite').addEventListener('click', async () => {
    if (!activeRoomId) return;
    try {
      const r = await api('/api/rooms/' + activeRoomId + '/invite');
      $('invite-text').textContent = r.ticket;
      openDialog('invite-dialog');
    } catch (e) { toast(e.message, 'err'); }
  });
  $('copy-btn').addEventListener('click', () => {
    const t = $('invite-text').textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(t).then(() => toast('Copied.'));
    } else {
      const r = document.createRange(); r.selectNode($('invite-text'));
      getSelection().removeAllRanges(); getSelection().addRange(r);
      try { document.execCommand('copy'); toast('Copied.'); }
      catch (_) { toast('Select the ticket and copy manually.', 'warn'); }
    }
  });

  $('btn-admission').addEventListener('click', async () => {
    if (!activeRoomId) return;
    const room = rooms.find((r) => r.id === activeRoomId);
    if (!room) return;
    if (!room.is_creator) { toast('Only the creator can change admission.', 'err'); return; }
    const next = room.admission === 'open' ? 'approval' : 'open';
    try {
      await api('/api/rooms/' + activeRoomId + '/admission', {
        method: 'POST', body: JSON.stringify({ mode: next }),
      });
      toast('Admission: ' + next);
      await refreshRooms();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('btn-settings').addEventListener('click', () => {
    if (me) $('nick-input').value = me.nickname || '';
    openDialog('settings-dialog');
  });
  $('nick-submit').addEventListener('click', async () => {
    const nick = $('nick-input').value.trim();
    if (!nick) return;
    try {
      await api('/api/nickname', { method: 'POST', body: JSON.stringify({ nickname: nick }) });
      me.nickname = nick;
      renderMe();
      $('settings-dialog').close();
      toast('Saved.');
    } catch (e) { toast(e.message, 'err'); }
  });

  qsa('[data-theme-set]').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.getAttribute('data-theme-set')));
  });

  $('btn-sidebar').addEventListener('click', () => $('app').classList.toggle('sidebar-open'));
  $('btn-aside').addEventListener('click', () => {
    const app = $('app');
    if (window.matchMedia('(max-width: 960px)').matches) {
      app.classList.toggle('aside-open');
    } else {
      app.classList.toggle('aside-collapsed');
    }
  });
  $('btn-aside-close').addEventListener('click', () => $('app').classList.remove('aside-open'));
  $('backdrop').addEventListener('click', () => {
    $('app').classList.remove('sidebar-open');
    $('app').classList.remove('aside-open');
  });

  // composer
  const input = $('input');
  input.addEventListener('input', () => { autosizeInput(); updateSendButton(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });

  // shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      qsa('dialog[open]').forEach((d) => d.close());
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('btn-new-room').click();
    }
  });

  // ------- boot -------
  if (token) login(); else $('login').classList.remove('hidden');
})();
</script>
</body>
</html>`;
