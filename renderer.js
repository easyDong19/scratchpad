/* global require, monaco, window */
require.config({ paths: { vs: 'node_modules/monaco-editor/min/vs' } });

const FONT_MIN = 8;
const FONT_MAX = 40;
const STORAGE_CODE = 'scratchpad.code';
const STORAGE_FONT = 'scratchpad.fontSize';
const STORAGE_MEMO = 'scratchpad.memo';
const STORAGE_MEMO_OPEN = 'scratchpad.memoOpen';
const STORAGE_MEMO_WIDTH = 'scratchpad.memoWidth';
const STORAGE_AC = 'scratchpad.autocomplete';
const STORAGE_TERM_OPEN = 'scratchpad.termOpen';
const STORAGE_TERM_HEIGHT = 'scratchpad.termHeight';
const MEMO_MIN_WIDTH = 160;
const EDITOR_MIN_WIDTH = 240;

const MEMO_PLACEHOLDER = [
  '// 정답 / 참고 코드를 여기에 붙여넣고 왼쪽에서 따라 치세요.',
  '// Ctrl+X 로 이 패널을 닫았다 열 수 있습니다.',
  '// 경계선을 드래그하면 폭이 조절됩니다.',
  '',
].join('\n');

const DEFAULT_CODE = [
  '#include <string>',
  '#include <vector>',
  '',
  'using namespace std;',
  '',
  'int solution(vector<int> numbers) {',
  '    int answer = 0;',
  '    ',
  '    return answer;',
  '}',
  '',
].join('\n');

require(['vs/editor/editor.main'], async function () {
  const info = await window.lsp.getInfo();
  const FILE_URI = info.fileUri;

  let fontSize = parseInt(localStorage.getItem(STORAGE_FONT), 10);
  if (!fontSize || fontSize < FONT_MIN || fontSize > FONT_MAX) fontSize = 15;

  const editor = monaco.editor.create(document.getElementById('container'), {
    value: localStorage.getItem(STORAGE_CODE) ?? DEFAULT_CODE,
    language: 'cpp',
    theme: 'vs-dark',
    fontSize: fontSize,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    minimap: { enabled: false },
    automaticLayout: true,
    tabSize: 4,
    insertSpaces: true,
    // 자동완성은 clangd(LSP)가 전담 — VS Code C++ 확장과 동일한 동작
    wordBasedSuggestions: 'off',
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    snippetSuggestions: 'inline',
    scrollBeyondLastLine: true,
    renderWhitespace: 'none',
    cursorBlinking: 'smooth',
  });
  const model = editor.getModel();
  editor.focus();

  // ---- persist content ----
  let saveTimer = null;
  editor.onDidChangeModelContent(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      localStorage.setItem(STORAGE_CODE, editor.getValue());
    }, 300);
  });
  window.addEventListener('beforeunload', () => {
    localStorage.setItem(STORAGE_CODE, editor.getValue());
  });

  // ---- font size: Cmd/Ctrl +, Cmd/Ctrl -, Cmd/Ctrl 0 ----
  const status = document.getElementById('statusbar');
  let statusTimer = null;
  function showStatus(text, sticky) {
    status.textContent = text;
    clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(() => { status.textContent = ''; }, 1500);
  }

  function setFontSize(px) {
    fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
    editor.updateOptions({ fontSize });
    if (typeof memoEditor !== 'undefined') memoEditor.updateOptions({ fontSize });
    localStorage.setItem(STORAGE_FONT, String(fontSize));
    showStatus('글자 크기 ' + fontSize + 'px' +
      (fontSize === FONT_MAX ? ' (최대)' : fontSize === FONT_MIN ? ' (최소)' : ''));
  }

  const K = monaco.KeyMod;
  const C = monaco.KeyCode;
  editor.addCommand(K.CtrlCmd | C.Equal, () => setFontSize(fontSize + 1));
  editor.addCommand(K.CtrlCmd | K.Shift | C.Equal, () => setFontSize(fontSize + 1));
  editor.addCommand(K.CtrlCmd | C.Minus, () => setFontSize(fontSize - 1));
  editor.addCommand(K.CtrlCmd | C.Digit0, () => setFontSize(15));

  // =========================================================
  // 메모 패널 — 정답을 옆에 띄워놓고 따라 치기 (Ctrl+X 토글)
  // =========================================================
  const memoEditor = monaco.editor.create(document.getElementById('memo-editor'), {
    value: localStorage.getItem(STORAGE_MEMO) ?? MEMO_PLACEHOLDER,
    language: 'cpp',
    theme: 'vs-dark',
    fontSize: fontSize,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    minimap: { enabled: false },
    automaticLayout: true,
    tabSize: 4,
    insertSpaces: true,
    wordWrap: 'on',
    folding: false,
    renderLineHighlight: 'none',
    occurrencesHighlight: 'off',
    scrollBeyondLastLine: false,
    // 메모는 참고용 — 자동완성/진단은 왼쪽 편집기 전용
    wordBasedSuggestions: 'off',
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    hover: { enabled: false },
  });
  let memoSaveTimer = null;
  memoEditor.onDidChangeModelContent(() => {
    clearTimeout(memoSaveTimer);
    memoSaveTimer = setTimeout(() => {
      localStorage.setItem(STORAGE_MEMO, memoEditor.getValue());
    }, 300);
  });
  window.addEventListener('beforeunload', () => {
    localStorage.setItem(STORAGE_MEMO, memoEditor.getValue());
  });

  // ---- 열기/닫기 ----
  const memoPanel = document.getElementById('memo');
  const resizer = document.getElementById('resizer');

  const savedWidth = parseInt(localStorage.getItem(STORAGE_MEMO_WIDTH), 10);
  if (savedWidth >= MEMO_MIN_WIDTH) memoPanel.style.width = savedWidth + 'px';

  let memoOpen = false;
  function setMemoOpen(open, silent) {
    memoOpen = open;
    document.body.classList.toggle('memo-closed', !open);
    localStorage.setItem(STORAGE_MEMO_OPEN, open ? '1' : '0');
    if (open) memoEditor.layout();
    editor.layout();
    // 포커스는 항상 왼쪽(타이핑하는 쪽)에 남긴다
    editor.focus();
    if (!silent) showStatus(open ? '메모 열림 · Ctrl+X로 닫기' : '메모 닫힘 · Ctrl+X로 열기');
  }
  setMemoOpen(localStorage.getItem(STORAGE_MEMO_OPEN) === '1', true);

  // =========================================================
  // 자동완성 토글 (Ctrl+C) — 코테 사이트 실전 환경 연습용
  // =========================================================
  let acEnabled = localStorage.getItem(STORAGE_AC) !== '0';
  function setAutocomplete(on, silent) {
    acEnabled = on;
    editor.updateOptions({
      quickSuggestions: on ? { other: true, comments: false, strings: false } : false,
      suggestOnTriggerCharacters: on,
      parameterHints: { enabled: on },
    });
    localStorage.setItem(STORAGE_AC, on ? '1' : '0');
    if (!silent) showStatus(on ? '자동완성 ON' : '자동완성 OFF — 실전 모드 · Ctrl+C로 다시 켜기');
  }
  setAutocomplete(acEnabled, true);

  // =========================================================
  // 하단 터미널 — 컴파일+실행 (Ctrl+V 토글, Cmd+Enter 실행)
  // =========================================================
  const termPanel = document.getElementById('term-panel');
  const hresizer = document.getElementById('hresizer');
  const TERM_MIN_HEIGHT = 80;
  const EDITOR_MIN_HEIGHT = 160;

  const xterm = new window.Terminal({
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    cursorBlink: true,
    theme: { background: '#141414' },
  });
  const fitAddon = new window.FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.open(document.getElementById('terminal'));

  xterm.onData((d) => window.term.input(d));
  xterm.onResize(({ cols, rows }) => window.term.resize({ cols, rows }));
  window.term.onData((d) => xterm.write(d));
  window.term.onExit((code) => {
    xterm.write('\r\n\x1b[90m[프로세스 종료 · 코드 ' + code + '] Cmd+Enter로 다시 실행\x1b[0m\r\n');
  });

  const savedTermHeight = parseInt(localStorage.getItem(STORAGE_TERM_HEIGHT), 10);
  if (savedTermHeight >= TERM_MIN_HEIGHT) termPanel.style.height = savedTermHeight + 'px';

  let termOpen = false;
  function setTermOpen(open, silent) {
    termOpen = open;
    document.body.classList.toggle('term-closed', !open);
    localStorage.setItem(STORAGE_TERM_OPEN, open ? '1' : '0');
    if (open) fitAddon.fit();
    editor.layout();
    if (!open) editor.focus();
    if (!silent) showStatus(open ? '터미널 열림 · Ctrl+V로 닫기' : '터미널 닫힘 · Ctrl+V로 열기');
  }
  setTermOpen(localStorage.getItem(STORAGE_TERM_OPEN) === '1', true);

  function runCode() {
    if (!termOpen) setTermOpen(true, true);
    xterm.reset();
    fitAddon.fit();
    xterm.write('\x1b[90m$ clang++ -std=c++20 scratch.cpp && ./scratch\x1b[0m\r\n');
    window.term.start({ code: editor.getValue(), cols: xterm.cols, rows: xterm.rows });
    xterm.focus(); // 실행 즉시 cin 입력 가능
  }
  editor.addCommand(K.CtrlCmd | C.Enter, runCode);

  window.addEventListener('resize', () => { if (termOpen) fitAddon.fit(); });

  // =========================================================
  // 단축키 모음집 (Cmd+/ · 메뉴 > 도움말 · Esc로 닫기)
  // =========================================================
  const shortcutsOverlay = document.getElementById('shortcuts-overlay');
  function setShortcutsOpen(open) {
    shortcutsOverlay.classList.toggle('open', open);
    if (!open) editor.focus();
  }
  window.ui.onShowShortcuts(() => setShortcutsOpen(!shortcutsOverlay.classList.contains('open')));
  shortcutsOverlay.addEventListener('mousedown', (e) => {
    if (e.target === shortcutsOverlay) setShortcutsOpen(false);
  });

  // ---- 전역 키 처리 — Monaco/xterm 키바인딩보다 우선 (capture) ----
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shortcutsOverlay.classList.contains('open')) {
      e.preventDefault();
      setShortcutsOpen(false);
      return;
    }
    // Cmd+Enter — 터미널에 포커스가 있어도 재실행
    if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      runCode();
      return;
    }
    if (!e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    const inTerm = termPanel.contains(e.target);
    if (key === 'v') {
      e.preventDefault();
      e.stopPropagation();
      setTermOpen(!termOpen);
      return;
    }
    if (key !== 'x' && key !== 'c') return;
    // 터미널 안의 Ctrl+C는 SIGINT (무한 루프 중단) — xterm이 처리하게 둔다
    if (inTerm) return;
    e.preventDefault();
    e.stopPropagation();
    if (key === 'x') setMemoOpen(!memoOpen);
    else setAutocomplete(!acEnabled);
  }, true);

  // ---- 터미널 높이 드래그 조절 ----
  let hDragging = false;
  hresizer.addEventListener('mousedown', (e) => {
    hDragging = true;
    hresizer.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!hDragging) return;
    const max = Math.max(TERM_MIN_HEIGHT, window.innerHeight - EDITOR_MIN_HEIGHT);
    const h = Math.min(max, Math.max(TERM_MIN_HEIGHT, window.innerHeight - e.clientY));
    termPanel.style.height = h + 'px';
    fitAddon.fit();
  });
  window.addEventListener('mouseup', () => {
    if (!hDragging) return;
    hDragging = false;
    hresizer.classList.remove('dragging');
    localStorage.setItem(STORAGE_TERM_HEIGHT, String(termPanel.clientHeight));
  });

  // ---- 경계선 드래그로 폭 조절 ----
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const max = Math.max(MEMO_MIN_WIDTH, window.innerWidth - EDITOR_MIN_WIDTH);
    const width = Math.min(max, Math.max(MEMO_MIN_WIDTH, window.innerWidth - e.clientX));
    memoPanel.style.width = width + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    localStorage.setItem(STORAGE_MEMO_WIDTH, String(memoPanel.clientWidth));
  });

  // =========================================================
  // clangd LSP client
  // =========================================================
  let nextId = 1;
  let docVersion = 1;
  let ready = false;
  const pending = new Map();

  function send(msg) {
    window.lsp.send(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  }
  function notify(method, params) {
    send({ method, params });
  }
  function request(method, params) {
    return new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ id, method, params });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve(null); }
      }, 5000);
    });
  }

  window.lsp.onStatus((s) => showStatus('LSP: ' + s, true));

  window.lsp.onMessage((raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.id !== undefined && msg.method) {
      // server → client request: 안전한 기본 응답
      if (msg.method === 'workspace/configuration') {
        send({ id: msg.id, result: (msg.params.items || []).map(() => null) });
      } else {
        send({ id: msg.id, result: null });
      }
      return;
    }
    if (msg.id !== undefined) {
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg.result ?? null); }
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      if (msg.params.uri !== FILE_URI) return;
      monaco.editor.setModelMarkers(model, 'clangd',
        (msg.params.diagnostics || []).map(toMarker));
    }
  });

  // ---- position / range conversion ----
  const toLspPos = (p) => ({ line: p.lineNumber - 1, character: p.column - 1 });
  const toRange = (r) => new monaco.Range(
    r.start.line + 1, r.start.character + 1,
    r.end.line + 1, r.end.character + 1
  );

  const SEVERITY = {
    1: monaco.MarkerSeverity.Error,
    2: monaco.MarkerSeverity.Warning,
    3: monaco.MarkerSeverity.Info,
    4: monaco.MarkerSeverity.Hint,
  };
  function toMarker(d) {
    return {
      severity: SEVERITY[d.severity] || monaco.MarkerSeverity.Info,
      message: d.message,
      source: d.source || 'clangd',
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
    };
  }

  // LSP CompletionItemKind(1..25) → Monaco kind
  const MK = monaco.languages.CompletionItemKind;
  const KIND = [null, MK.Text, MK.Method, MK.Function, MK.Constructor, MK.Field,
    MK.Variable, MK.Class, MK.Interface, MK.Module, MK.Property, MK.Unit,
    MK.Value, MK.Enum, MK.Keyword, MK.Snippet, MK.Color, MK.File,
    MK.Reference, MK.Folder, MK.EnumMember, MK.Constant, MK.Struct,
    MK.Event, MK.Operator, MK.TypeParameter];

  const docText = (d) => (typeof d === 'string' ? d : d && d.value) || undefined;

  function toSuggestion(item, defaultRange) {
    let insertText = item.insertText || item.label;
    let range = defaultRange;
    if (item.textEdit) {
      insertText = item.textEdit.newText;
      const r = item.textEdit.range || item.textEdit.replace;
      if (r) range = toRange(r);
    }
    return {
      label: typeof item.label === 'string'
        ? { label: item.label, description: item.detail }
        : item.label,
      kind: KIND[item.kind] || MK.Text,
      detail: item.detail,
      documentation: docText(item.documentation),
      insertText,
      insertTextRules: item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
      filterText: item.filterText,
      sortText: item.sortText,
      range,
      additionalTextEdits: (item.additionalTextEdits || []).map((e) => ({
        range: toRange(e.range),
        text: e.newText,
      })),
      command: undefined,
      _lsp: item,
    };
  }

  // ---- didChange: 매 변경마다 전체 동기화 (파일이 작아 비용 무시 가능) ----
  editor.onDidChangeModelContent(() => {
    if (!ready) return;
    docVersion++;
    notify('textDocument/didChange', {
      textDocument: { uri: FILE_URI, version: docVersion },
      contentChanges: [{ text: editor.getValue() }],
    });
  });

  // ---- providers (요청은 ready 이후에만 실제 전송됨) ----
  monaco.languages.registerCompletionItemProvider('cpp', {
    triggerCharacters: ['.', '<', '>', ':', '"', '/', '*', '#'],
    async provideCompletionItems(mdl, position) {
      if (!ready || !acEnabled || mdl !== model) return { suggestions: [] };
      const result = await request('textDocument/completion', {
        textDocument: { uri: FILE_URI },
        position: toLspPos(position),
      });
      if (!result) return { suggestions: [] };
      const items = Array.isArray(result) ? result : result.items || [];
      const word = mdl.getWordUntilPosition(position);
      const defaultRange = new monaco.Range(
        position.lineNumber, word.startColumn,
        position.lineNumber, word.endColumn
      );
      return {
        suggestions: items.map((i) => toSuggestion(i, defaultRange)),
        incomplete: !!result.isIncomplete,
      };
    },
    async resolveCompletionItem(item) {
      if (!item._lsp) return item;
      const resolved = await request('completionItem/resolve', item._lsp);
      if (resolved) {
        item.detail = resolved.detail || item.detail;
        item.documentation = docText(resolved.documentation) || item.documentation;
      }
      return item;
    },
  });

  monaco.languages.registerSignatureHelpProvider('cpp', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(mdl, position) {
      if (!ready || !acEnabled || mdl !== model) return null;
      const sh = await request('textDocument/signatureHelp', {
        textDocument: { uri: FILE_URI },
        position: toLspPos(position),
      });
      if (!sh || !sh.signatures || !sh.signatures.length) return null;
      return {
        value: {
          signatures: sh.signatures.map((s) => ({
            label: s.label,
            documentation: docText(s.documentation),
            parameters: (s.parameters || []).map((p) => ({
              label: p.label,
              documentation: docText(p.documentation),
            })),
          })),
          activeSignature: sh.activeSignature || 0,
          activeParameter: sh.activeParameter || 0,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerDocumentFormattingEditProvider('cpp', {
    async provideDocumentFormattingEdits(mdl) {
      if (!ready || mdl !== model) return [];
      const edits = await request('textDocument/formatting', {
        textDocument: { uri: FILE_URI },
        options: { tabSize: 4, insertSpaces: true },
      });
      return (edits || []).map((e) => ({
        range: toRange(e.range),
        text: e.newText,
      }));
    },
  });

  // Cmd+S: 코드 포매팅 (clang-format via clangd) + 저장
  editor.addCommand(K.CtrlCmd | C.KeyS, async () => {
    await editor.getAction('editor.action.formatDocument').run();
    localStorage.setItem(STORAGE_CODE, editor.getValue());
    showStatus('포맷 완료');
  });

  monaco.languages.registerHoverProvider('cpp', {
    async provideHover(mdl, position) {
      if (!ready || mdl !== model) return null;
      const h = await request('textDocument/hover', {
        textDocument: { uri: FILE_URI },
        position: toLspPos(position),
      });
      if (!h || !h.contents) return null;
      const contents = Array.isArray(h.contents) ? h.contents : [h.contents];
      return {
        range: h.range ? toRange(h.range) : undefined,
        contents: contents.map((c) => ({ value: docText(c) || String(c) })),
      };
    },
  });

  // ---- initialize handshake ----
  const initResult = await request('initialize', {
    processId: null,
    rootUri: info.rootUri,
    capabilities: {
      textDocument: {
        synchronization: { didSave: false },
        completion: {
          contextSupport: true,
          completionItem: {
            snippetSupport: true,
            documentationFormat: ['plaintext', 'markdown'],
            insertReplaceSupport: true,
            resolveSupport: { properties: ['documentation', 'detail'] },
          },
        },
        signatureHelp: {
          signatureInformation: {
            documentationFormat: ['plaintext', 'markdown'],
            parameterInformation: { labelOffsetSupport: true },
          },
        },
        hover: { contentFormat: ['plaintext', 'markdown'] },
        publishDiagnostics: {},
      },
    },
    initializationOptions: {},
  });

  if (initResult) {
    notify('initialized', {});
    notify('textDocument/didOpen', {
      textDocument: {
        uri: FILE_URI,
        languageId: 'cpp',
        version: docVersion,
        text: editor.getValue(),
      },
    });
    ready = true;
    showStatus('clangd 연결됨 · Cmd+Enter: 실행 · Ctrl+V: 터미널 · Cmd+/: 단축키');
  } else {
    showStatus('clangd 초기화 실패 — 자동완성 비활성', true);
  }
});
