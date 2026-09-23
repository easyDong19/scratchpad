const { app, BrowserWindow, Menu, globalShortcut, ipcMain, nativeImage, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { nfc, findTemplateFiles, parseTemplateMd } = require('./template-parser');

let win = null;
let clangd = null;
let runPty = null;

// 작업 파일은 앱 번들이 아니라 사용자 데이터 폴더에 둔다
let WORK_DIR = null;
let SCRATCH_FILE = null;
let TEMPLATES_FILE = null;

// ---- 개발 도구 환경 검사 (첫 실행 설정 화면용) ----
// /usr/bin/clang++·clangd는 CLT가 없어도 존재하는 shim이라(실행 시 설치 팝업) 실제 경로로 확인한다
const BREW_BIN = '/opt/homebrew/bin/brew';

function developerDir() {
  const r = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' });
  const dir = r.status === 0 ? r.stdout.trim() : '';
  return dir && fs.existsSync(dir) ? dir : null;
}

function findTool(dev, name) {
  if (!dev) return null;
  const candidates = [
    path.join(dev, 'usr/bin', name), // Command Line Tools
    path.join(dev, 'Toolchains/XcodeDefault.xctoolchain/usr/bin', name), // Xcode.app
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function checkEnv() {
  const dev = developerDir();
  const g = gccPaths();
  return {
    clangxx: findTool(dev, 'clang++'),
    clangd: findTool(dev, 'clangd'),
    brew: fs.existsSync(BREW_BIN),
    gcc: g ? path.basename(g.inc) : null,
  };
}

let env = null;

// clangd가 읽는 compile_flags.txt를 설치된 GCC 버전·아키텍처로 생성 (macOS·GCC 버전이 달라도 동작)
function writeCompileFlags() {
  const g = gccPaths();
  const lines = ['-xc++', '-std=c++20'];
  if (g) lines.push('-nostdinc++', '-isystem' + g.inc, '-isystem' + g.arch, '-isystem' + g.backward);
  fs.writeFileSync(path.join(WORK_DIR, 'compile_flags.txt'), lines.join('\n') + '\n');
}

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
  if (!env.clangd) return;
  clangd = spawn(env.clangd, [
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
  clangd: !!clangd,
}));

ipcMain.handle('env-check', () => (env = checkEnv()));

ipcMain.handle('env-install-xcode', () => {
  // macOS 기본 설치 창을 띄운다 (이미 설치돼 있으면 조용히 실패)
  spawn('/usr/bin/xcode-select', ['--install'], { stdio: 'ignore', detached: true }).unref();
});

ipcMain.handle('env-open-terminal', () => {
  spawn('/usr/bin/open', ['-a', 'Terminal'], { stdio: 'ignore', detached: true }).unref();
});

// 설치 후 "다시 확인" — 새로 생긴 도구로 clangd를 다시 띄우고 렌더러를 새로 고쳐 LSP를 다시 붙인다
ipcMain.handle('env-apply', () => {
  env = checkEnv();
  writeCompileFlags();
  if (clangd) { clangd.removeAllListeners('exit'); clangd.kill(); clangd = null; }
  startClangd();
  if (win && !win.isDestroyed()) win.webContents.reload();
});

// ---- 컴파일 + 실행 (하단 터미널, PTY라 cin 대화형 입력 가능) ----
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

  env = checkEnv(); // 앱을 켠 뒤에 설치했을 수도 있으니 매번 다시 확인
  const g = gccPaths();
  if (!env.clangxx) {
    send('term-data', '\x1b[31mclang++ 없음 — Xcode Command Line Tools 필요 (메뉴 > 도움말 > 개발 도구 환경 확인)\x1b[0m\r\n');
    send('term-exit', 1);
    return;
  }
  if (!g) {
    send('term-data', '\x1b[31mGCC 없음 — brew install gcc 필요, bits/stdc++.h 헤더용 (메뉴 > 도움말 > 개발 도구 환경 확인)\x1b[0m\r\n');
    send('term-exit', 1);
    return;
  }

  const bin = path.join(WORK_DIR, 'scratch.bin');
  const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
  const script =
    `${q(env.clangxx)} -std=c++20 -O2 -nostdinc++` +
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

// ---- 템플릿 드릴: 저장소 (userData/templates.json) + 레포 템플릿.md 가져오기 ----
ipcMain.handle('tpl-load', () => {
  if (!fs.existsSync(TEMPLATES_FILE)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    return Array.isArray(j.templates) ? j.templates : [];
  } catch (_) {
    // 깨진 파일을 빈 목록으로 덮어쓰지 않도록 옆으로 치워 둔다
    fs.renameSync(TEMPLATES_FILE, TEMPLATES_FILE + '.bad-' + Date.now());
    return [];
  }
});

ipcMain.handle('tpl-save', (_e, templates) => {
  const tmp = TEMPLATES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, templates }, null, 2));
  fs.renameSync(tmp, TEMPLATES_FILE);
  return true;
});

ipcMain.handle('tpl-pick-dir', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath: current || app.getPath('home'),
  });
  return r.canceled ? null : r.filePaths[0];
});

const DEFAULT_TPL_DIR = () => path.join(app.getPath('home'), 'woodie', 'study', 'coding-test');

ipcMain.handle('tpl-scan', (_e, dirArg) => {
  const dir = dirArg || DEFAULT_TPL_DIR();
  try {
    const files = findTemplateFiles(dir);
    if (!files.length) return { dir, items: [], error: '이 폴더에서 템플릿.md를 찾지 못했어요' };
    const items = [];
    for (const f of files) {
      const source = nfc(path.relative(path.dirname(dir), f));
      items.push(...parseTemplateMd(fs.readFileSync(f, 'utf8'), source).items);
    }
    return { dir, items, error: null };
  } catch (err) {
    return { dir, items: [], error: '폴더를 읽지 못했어요: ' + err.message };
  }
});

app.whenReady().then(() => {
  WORK_DIR = app.getPath('userData');
  SCRATCH_FILE = path.join(WORK_DIR, 'scratch.cpp');
  TEMPLATES_FILE = path.join(WORK_DIR, 'templates.json');

  // clangd가 붙을 실제 파일 (내용은 렌더러의 didOpen이 진실)
  if (!fs.existsSync(SCRATCH_FILE)) fs.writeFileSync(SCRATCH_FILE, '');
  // clangd가 읽는 설정: compile_flags.txt는 설치된 GCC로 생성, .clang-format은 복사
  env = checkEnv();
  writeCompileFlags();
  fs.copyFileSync(path.join(__dirname, '.clang-format'), path.join(WORK_DIR, '.clang-format'));

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
        { label: '단축키 모음집', accelerator: 'CmdOrCtrl+Shift+/', click: showShortcuts },
        { label: '개발 도구 환경 확인…', click: () => win && !win.isDestroyed() && win.webContents.send('show-setup') },
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

// 자동완성 토글: kill -USR1 <pid> (자동화/문서용 — Ctrl+C와 동일 동작)
process.on('SIGUSR1', () => {
  if (win && !win.isDestroyed()) win.webContents.send('toggle-autocomplete');
});

// 스크린샷: kill -USR2 <pid> 로 창 내용을 PNG로 저장 (문서용)
process.on('SIGUSR2', async () => {
  if (!win || win.isDestroyed()) return;
  try {
    const img = await win.webContents.capturePage();
    const out = path.join(WORK_DIR, 'capture-' + Date.now() + '.png');
    fs.writeFileSync(out, img.toPNG());
  } catch (_) {}
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (clangd) clangd.kill();
  killRun();
});

app.on('window-all-closed', () => {
  app.quit();
});
