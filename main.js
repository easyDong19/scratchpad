const { app, BrowserWindow, Menu, globalShortcut, ipcMain, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

let win = null;
let clangd = null;
let runPty = null;

// 작업 파일은 앱 번들이 아니라 사용자 데이터 폴더에 둔다
let WORK_DIR = null;
let SCRATCH_FILE = null;
const CLANGD_BIN = '/usr/bin/clangd';

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Scratchpad',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.setMenuBarVisibility(false);

  // --- 디버그: 창/앱 이벤트 로그 ---
  const logFile = path.join(WORK_DIR, 'events.log');
  const elog = (m) => { try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + m + '\n'); } catch (_) {} };
  elog('createWindow');
  for (const ev of ['show', 'hide', 'minimize', 'restore', 'blur', 'focus', 'close', 'closed', 'ready-to-show', 'unresponsive']) {
    win.on(ev, () => elog('win:' + ev + ' visible=' + (win.isDestroyed() ? '?' : win.isVisible()) + ' min=' + (win.isDestroyed() ? '?' : win.isMinimized())));
  }
  for (const ev of ['browser-window-blur', 'browser-window-focus', 'did-become-active', 'did-resign-active', 'activate', 'before-quit', 'will-quit']) {
    app.on(ev, () => elog('app:' + ev));
  }
  win.webContents.on('render-process-gone', (_e, d) => elog('renderer gone: ' + JSON.stringify(d)));
  win.webContents.on('did-finish-load', () => elog('did-finish-load'));
  // 보스키로 불렀을 때 항상 "지금 보고 있는" 스페이스에 나타나도록
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  // 렌더링 준비 후 확실히 표시 + 포커스 (런치 직후 hidden으로 남는 문제 방지)
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    app.focus({ steal: true });
    setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isVisible()) { win.show(); win.focus(); }
    }, 800);
  });
}

function toggleBossKey() {
  try { fs.appendFileSync(path.join(WORK_DIR, 'events.log'), new Date().toISOString() + ' BOSSKEY visible=' + (win ? win.isVisible() : '?') + '\n'); } catch (_) {}
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
    if (process.platform === 'darwin') app.hide();
  } else {
    win.show();
    win.focus();
  }
}

// ---- clangd process + LSP stdio framing ----
function startClangd() {
  if (!fs.existsSync(CLANGD_BIN)) {
    if (win) win.webContents.send('lsp-status', 'clangd not found');
    return;
  }
  clangd = spawn(CLANGD_BIN, [
    '--completion-style=detailed',
    '--header-insertion=iwyu',
    '--function-arg-placeholders=true',
    '--background-index=false',
    '--log=error',
  ], { cwd: WORK_DIR });

  let buf = Buffer.alloc(0);
  clangd.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buf.slice(0, headerEnd).toString('utf8');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { buf = buf.slice(headerEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      const start = headerEnd + 4;
      if (buf.length < start + len) break;
      const msg = buf.slice(start, start + len).toString('utf8');
      buf = buf.slice(start + len);
      if (win && !win.isDestroyed()) win.webContents.send('lsp-message', msg);
    }
  });

  clangd.stderr.on('data', () => {});
  clangd.on('exit', () => {
    clangd = null;
    if (win && !win.isDestroyed()) win.webContents.send('lsp-status', 'clangd exited');
  });
}

ipcMain.on('lsp-send', (_e, json) => {
  if (!clangd || !clangd.stdin.writable) return;
  clangd.stdin.write(
    'Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json
  );
});

ipcMain.handle('lsp-info', () => ({
  rootUri: 'file://' + WORK_DIR,
  fileUri: 'file://' + SCRATCH_FILE,
}));

// ---- 컴파일 + 실행 (하단 터미널, PTY라 cin 대화형 입력 가능) ----
const CXX = '/usr/bin/clang++';

// clangd와 동일한 libstdc++(Homebrew GCC) 헤더로 컴파일 — bits/stdc++.h 지원
function gccPaths() {
  const incRoot = '/opt/homebrew/opt/gcc/include/c++';
  const libRoot = '/opt/homebrew/opt/gcc/lib/gcc';
  try {
    const ver = fs.readdirSync(incRoot).filter((v) => /^\d+/.test(v)).sort((a, b) => b - a)[0];
    if (!ver) return null;
    const inc = path.join(incRoot, ver);
    const arch = fs.readdirSync(inc).find((d) => d.includes('apple-darwin'));
    const dylib = path.join(libRoot, ver, 'libstdc++.dylib');
    if (!arch || !fs.existsSync(dylib)) return null;
    return { inc, arch: path.join(inc, arch), backward: path.join(inc, 'backward'), dylib };
  } catch (_) {
    return null;
  }
}

function killRun() {
  if (runPty) {
    try { runPty.kill(); } catch (_) {}
    runPty = null;
  }
}

ipcMain.on('run-start', (_e, { code, cols, rows }) => {
  killRun();
  fs.writeFileSync(SCRATCH_FILE, code);

  const send = (ch, ...args) => {
    if (win && !win.isDestroyed()) win.webContents.send(ch, ...args);
  };

  const g = gccPaths();
  if (!fs.existsSync(CXX)) {
    send('term-data', '\x1b[31mclang++ 없음 — Xcode Command Line Tools 필요: xcode-select --install\x1b[0m\r\n');
    send('term-exit', 1);
    return;
  }
  if (!g) {
    send('term-data', '\x1b[31mGCC libstdc++ 없음 — brew install gcc 필요 (bits/stdc++.h 헤더용)\x1b[0m\r\n');
    send('term-exit', 1);
    return;
  }

  const bin = path.join(WORK_DIR, 'scratch.bin');
  const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  const script =
    `${q(CXX)} -std=c++20 -O2 -nostdinc++` +
    ` -isystem${q(g.inc)} -isystem${q(g.arch)} -isystem${q(g.backward)}` +
    ` ${q(SCRATCH_FILE)} -o ${q(bin)} -nostdlib++ ${q(g.dylib)}` +
    ` && exec ${q(bin)}`;

  runPty = pty.spawn('/bin/zsh', ['-c', script], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: WORK_DIR,
    env: process.env,
  });
  const me = runPty;
  me.onData((data) => { if (runPty === me) send('term-data', data); });
  me.onExit(({ exitCode }) => {
    if (runPty === me) { runPty = null; send('term-exit', exitCode); }
  });
});

ipcMain.on('run-input', (_e, data) => { if (runPty) runPty.write(data); });
ipcMain.on('run-resize', (_e, { cols, rows }) => {
  if (runPty && cols > 0 && rows > 0) { try { runPty.resize(cols, rows); } catch (_) {} }
});
ipcMain.on('run-kill', () => killRun());

app.whenReady().then(() => {
  WORK_DIR = app.getPath('userData');
  SCRATCH_FILE = path.join(WORK_DIR, 'scratch.cpp');

  // clangd가 붙을 실제 파일 (내용은 렌더러의 didOpen이 진실)
  if (!fs.existsSync(SCRATCH_FILE)) fs.writeFileSync(SCRATCH_FILE, '');
  // compile_flags.txt / .clang-format을 작업 폴더로 복사 (clangd가 읽음)
  for (const f of ['compile_flags.txt', '.clang-format']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(WORK_DIR, f));
  }

  // Dock 아이콘을 런타임에 직접 지정 (iconservices 캐시와 무관하게 보장)
  if (process.platform === 'darwin' && app.dock) {
    const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    if (!img.isEmpty()) app.dock.setIcon(img);
  }

  // 메뉴바: 기본 역할 + 단축키 모음집
  const showShortcuts = () => {
    if (win && !win.isDestroyed()) { win.show(); win.webContents.send('show-shortcuts'); }
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
    {
      label: '도움말',
      submenu: [
        { label: '단축키 모음집', accelerator: 'CmdOrCtrl+/', click: showShortcuts },
      ],
    },
  ]));

  createWindow();
  startClangd();

  // Boss key: Ctrl+Z (global — works even when another app has focus)
  const ok = globalShortcut.register('Control+Z', toggleBossKey);
  if (!ok) console.error('Failed to register Ctrl+Z global shortcut');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (win) win.show();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (clangd) clangd.kill();
  killRun();
});

app.on('window-all-closed', () => {
  app.quit();
});
