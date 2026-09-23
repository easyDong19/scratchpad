/* global window, document */
// =========================================================
// 템플릿 드릴 — 저장/수정/삭제 · 보고 따라치기 · 백지 복원 · 채점 · 레포 가져오기
// renderer.js가 에디터를 만든 뒤 window.initTemplates(ctx)로 붙인다.
// =========================================================
window.initTemplates = function initTemplates(ctx) {
  const { monaco, editor, memoEditor } = ctx;
  const STORAGE_TPL_DIR = 'scratchpad.tplDir';
  const STREAK_TO_GRADUATE = 2;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  let templates = [];
  let selectedId = null;
  let view = 'detail'; // detail | edit | import | guide
  let editingId = null; // null = 새 템플릿
  let confirmDeleteId = null;
  let importScan = null; // { dir, items, error }
  let importChecked = new Set();

  // 보고 따라치기 상태 (메모 패널에 템플릿 표시)
  let followId = null;
  const memoModel = memoEditor.getModel();
  const followModel = monaco.editor.createModel('', 'cpp');

  // 백지 복원 상태
  let drill = null; // { id, startedAt, timer, prevAc }
  let stash = null; // 복원 전 왼쪽 에디터 내용
  let resultOpen = false;

  const byId = (id) => templates.find((t) => t.id === id);
  const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- 정렬 · 표시 도우미 ----------
  function codeKey(code) {
    const m = String(code).match(/^T(\d+)-(\d+)$/i);
    return m ? [+m[1], +m[2], ''] : [999, 0, String(code)];
  }
  function sorted(list) {
    return list.slice().sort((a, b) => {
      if (a.stage !== b.stage) return a.stage - b.stage;
      const ka = codeKey(a.code), kb = codeKey(b.code);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
    });
  }
  function fmtGoal(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    if (!m) return s + '초';
    return s ? `${m}분 ${s}초` : `${m}분`;
  }
  function parseGoal(str) {
    const v = String(str).trim();
    if (/^\d+$/.test(v)) return +v;
    const mm = v.match(/(\d+)\s*분/), ss = v.match(/(\d+)\s*초/);
    if (!mm && !ss) return null;
    return (mm ? +mm[1] * 60 : 0) + (ss ? +ss[1] : 0);
  }
  const clock = (sec) => String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  function stamp(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function chip(t) {
    if (t.graduatedAt) return '<span class="chip ok">졸업 ✓</span>';
    if (t.attempts && t.attempts.length) return `<span class="chip half">${t.streak || 0}/${STREAK_TO_GRADUATE}</span>`;
    return '<span class="chip none">–</span>';
  }

  async function persist() {
    try {
      await window.tpl.save(templates);
    } catch (err) {
      ctx.showStatus('템플릿 저장 실패: ' + err.message, true);
    }
  }

  // =========================================================
  // 채점 — 주석·공백·#include 순서 무시, 줄 단위 비교
  // =========================================================
  function stripComments(src) {
    let out = '';
    let q = null;
    for (let i = 0; i < src.length; i++) {
      const c = src[i], d = src[i + 1];
      if (q) {
        out += c;
        if (c === '\\' && d !== undefined) { out += d; i++; } else if (c === q || c === '\n') q = null;
        continue;
      }
      if (c === '"' || c === "'") { q = c; out += c; continue; }
      if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
      if (c === '/' && d === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
        i++;
        continue;
      }
      out += c;
    }
    return out;
  }
  // 반환: 비교용 key 배열 + 화면용 줄 배열 (#include는 첫 등장 위치에 정렬해서 모음)
  function normalize(src) {
    const lines = stripComments(src).split('\n')
      .map((l) => l.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const isInc = (l) => /^#\s*include\b/.test(l);
    const key = (l) => l.replace(/\s+/g, '');
    const incs = lines.filter(isInc).sort((a, b) => key(a).localeCompare(key(b)));
    const out = [];
    let placed = false;
    for (const l of lines) {
      if (isInc(l)) { if (!placed) { out.push(...incs); placed = true; } continue; }
      out.push(l);
    }
    return { lines: out, keys: out.map(key) };
  }
  function lcsLen(a, b) {
    const dp = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      let prev = 0;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
        prev = tmp;
      }
    }
    return dp[b.length];
  }
  function judge(mine, answer) {
    const A = normalize(mine), B = normalize(answer);
    const common = lcsLen(A.keys, B.keys);
    const missing = B.keys.length - common; // 템플릿에 있는데 내 코드에 없는 줄
    const extra = A.keys.length - common; // 내 코드에만 있는 줄 (오타 포함)
    return { contentOk: missing === 0 && extra === 0, missing, extra, mineLines: A.lines, answerLines: B.lines };
  }

  // =========================================================
  // 라이브러리 오버레이 (Ctrl+T)
  // =========================================================
  const overlay = $('tpl-overlay');
  const isLibOpen = () => overlay.classList.contains('open');

  function openLibrary(id) {
    if (drill) { ctx.showStatus('백지 복원 중엔 라이브러리를 열 수 없어요 · Esc로 포기'); return; }
    if (id) selectedId = id;
    if (!byId(selectedId)) selectedId = sorted(templates)[0]?.id ?? null;
    view = 'detail';
    confirmDeleteId = null;
    overlay.classList.add('open');
    render();
    $('tpl-search').focus();
  }
  function closeLibrary() {
    overlay.classList.remove('open');
    editor.focus();
  }

  function render() {
    renderList();
    $('tpl-detail').hidden = view !== 'detail';
    $('tpl-edit').hidden = view !== 'edit';
    $('tpl-import').hidden = view !== 'import';
    $('tpl-guide').hidden = view !== 'guide';
    if (view === 'detail') renderDetail();
    if (view === 'import') renderImport();
    if (view === 'guide') renderGuide();
  }

  function renderList() {
    const q = $('tpl-search').value.trim().toLowerCase();
    const list = sorted(templates).filter((t) =>
      !q || (t.code + ' ' + t.title + ' ' + t.body).toLowerCase().includes(q));
    let html = '';
    let lastStage = null;
    for (const t of list) {
      if (t.stage !== lastStage) {
        lastStage = t.stage;
        html += `<div class="tpl-grp">STAGE ${esc(t.stage)}${t.stageName ? ' · ' + esc(t.stageName) : ''}</div>`;
      }
      html += `<button class="tpl-item${t.id === selectedId ? ' sel' : ''}" data-id="${esc(t.id)}">` +
        `<span><b>${esc(t.code)}</b> ${esc(t.title)}</span>${chip(t)}</button>`;
    }
    if (!templates.length) html = '<div class="tpl-empty">아직 템플릿이 없어요</div>';
    else if (!list.length) html = '<div class="tpl-empty">검색 결과가 없어요</div>';
    $('tpl-list').innerHTML = html;
  }

  function renderDetail() {
    const box = $('tpl-detail');
    const t = byId(selectedId);
    if (!t) {
      box.innerHTML = `<div class="tpl-blank"><b>템플릿이 없어요</b>
        <p>왼쪽 아래 <b>+ 새 템플릿</b>으로 직접 넣거나, <b>레포에서 가져오기</b>로 study 레포의 템플릿.md를 한 번에 불러오세요.</p><p>템플릿.md를 새로 만들려면 <button class="ghost" data-act="guide">작성 가이드</button></p></div>`;
      return;
    }
    const hist = (t.attempts || []).slice(-5).reverse().map((a) => {
      const cls = a.ok ? 'ok' : 'bad';
      const why = a.ok ? '' : a.contentOk ? ' · 시간 초과' : ` · ${Math.max(a.missing, a.extra)}줄 다름`;
      return `<span class="h ${cls}">${stamp(a.at)} · ${a.sec}초${why}</span>`;
    }).join('');
    const status = t.graduatedAt
      ? `졸업 ✓ (${stamp(t.graduatedAt)})`
      : `연속 성공 ${t.streak || 0}/${STREAK_TO_GRADUATE}`;
    box.innerHTML = `
      <div class="tpl-dhead">
        <div><b>${esc(t.code)} ${esc(t.title)}</b>
          <span>STAGE ${esc(t.stage)} · 목표 ${fmtGoal(t.goalSec)} · ${status}</span></div>
        <button class="ghost" data-act="close">닫기 Esc</button>
      </div>
      <pre class="tpl-preview" id="tpl-preview"></pre>
      <div class="tpl-hist"><span>최근</span>${hist || '<span class="h">아직 기록 없음</span>'}</div>
      ${confirmDeleteId === t.id ? `
        <div class="tpl-confirm"><span>${esc(t.code)}을(를) 삭제할까요? 시도 기록 ${(t.attempts || []).length}개도 같이 지워져요.</span>
          <span><button class="ghost" data-act="delete-cancel">취소</button><button class="danger" data-act="delete-yes">삭제</button></span></div>` : ''}
      <div class="tpl-act">
        <button data-act="follow">보고 따라치기</button>
        <button class="primary" data-act="drill">백지 복원 Ctrl+R</button>
        <button data-act="edit">수정</button>
        <button class="danger" data-act="delete">삭제</button>
      </div>`;
    const pre = $('tpl-preview');
    pre.textContent = t.body;
    monaco.editor.colorize(t.body, 'cpp', { tabSize: 4 }).then((html) => {
      if ($('tpl-preview') === pre) pre.innerHTML = html;
    });
  }

  // ---------- 추가 / 수정 ----------
  let formEditor = null;
  function openEdit(id) {
    editingId = id;
    view = 'edit';
    const t = id ? byId(id) : null;
    const last = byId(selectedId);
    $('tpl-f-code').value = t ? t.code : '';
    $('tpl-f-title').value = t ? t.title : '';
    $('tpl-f-stage').value = t ? t.stage : (last ? last.stage : 0);
    $('tpl-f-goal').value = t ? fmtGoal(t.goalSec) : '1분';
    $('tpl-f-error').textContent = '';
    $('tpl-edit-title').textContent = t ? `템플릿 수정 · ${t.code}` : '새 템플릿';
    render();
    if (!formEditor) {
      formEditor = monaco.editor.create($('tpl-f-body'), {
        value: '', language: 'cpp', theme: 'vs-dark', fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        minimap: { enabled: false }, automaticLayout: true, tabSize: 4, insertSpaces: true,
        scrollBeyondLastLine: false, wordBasedSuggestions: 'off', quickSuggestions: false,
        suggestOnTriggerCharacters: false, parameterHints: { enabled: false }, hover: { enabled: false },
      });
    }
    formEditor.setValue(t ? t.body : '');
    formEditor.layout();
    $('tpl-f-code').focus();
  }

  async function saveEdit() {
    const code = $('tpl-f-code').value.trim();
    const title = $('tpl-f-title').value.trim();
    const stage = parseInt($('tpl-f-stage').value, 10);
    const goalSec = parseGoal($('tpl-f-goal').value);
    const body = formEditor.getValue().replace(/\s+$/, '');
    const err = (m) => { $('tpl-f-error').textContent = m; };
    if (!code) return err('번호를 입력하세요 (예: T0-1)');
    if (!title) return err('이름을 입력하세요');
    if (!Number.isInteger(stage) || stage < 0) return err('STAGE는 0 이상의 숫자예요');
    if (!goalSec) return err('목표 시간은 "30초", "1분 30초", "90" 처럼 적어요');
    if (!body) return err('코드를 넣어 주세요');
    if (templates.some((t) => t.code === code && t.id !== editingId)) return err(`${code}는 이미 있어요`);

    if (editingId) {
      Object.assign(byId(editingId), { code, title, stage, goalSec, body });
    } else {
      const sameStage = templates.find((t) => t.stage === stage && t.stageName);
      const t = { id: newId(), code, title, stage, stageName: sameStage ? sameStage.stageName : '',
        goalSec, body, source: null, attempts: [], streak: 0, graduatedAt: null };
      templates.push(t);
      editingId = t.id;
    }
    selectedId = editingId;
    await persist();
    if (followId === editingId) showFollow(byId(followId));
    view = 'detail';
    render();
    ctx.showStatus('템플릿 저장됨');
  }

  async function deleteTemplate(id) {
    templates = templates.filter((t) => t.id !== id);
    if (followId === id) endFollow(true);
    const list = sorted(templates);
    selectedId = list[0]?.id ?? null;
    confirmDeleteId = null;
    await persist();
    render();
    ctx.showStatus('템플릿 삭제됨');
  }

  // ---------- 레포에서 가져오기 ----------
  function importStatus(item) {
    const t = templates.find((x) => x.code === item.code);
    if (!t) return 'new';
    return t.body === item.body && t.title === item.title && t.goalSec === item.goalSec ? 'same' : 'changed';
  }
  async function openImport(dir) {
    view = 'import';
    importScan = null;
    render();
    const saved = (() => { try { return localStorage.getItem(STORAGE_TPL_DIR); } catch (_) { return null; } })();
    importScan = await window.tpl.scan(dir || saved || null);
    importChecked = new Set(importScan.items.filter((i) => importStatus(i) !== 'same').map((i) => i.code));
    if (view === 'import') renderImport();
  }
  function renderImport() {
    const box = $('tpl-import');
    if (!importScan) { box.innerHTML = '<div class="tpl-blank">템플릿.md를 읽는 중…</div>'; return; }
    const { dir, items, error } = importScan;
    const label = { new: '<span class="chip ok">새로</span>', changed: '<span class="chip half">본문 바뀜</span>', same: '<span class="chip none">같음</span>' };
    const counts = { new: 0, changed: 0, same: 0 };
    const rows = items.map((i) => {
      const st = importStatus(i);
      counts[st]++;
      return `<label class="tpl-row"><input type="checkbox" data-code="${esc(i.code)}" ${importChecked.has(i.code) ? 'checked' : ''}>
        <span class="id">${esc(i.code)}</span><span>${esc(i.title)}</span><span class="id">${fmtGoal(i.goalSec)}</span>${label[st]}</label>`;
    }).join('');
    box.innerHTML = `
      <div class="tpl-dhead"><div><b>레포에서 가져오기</b>
        <span>stage*/템플릿.md의 "## T0-1. 제목 (30초)" 헤더와 아래 코드 블록을 읽어요</span></div>
        <span style="display:flex;gap:6px"><button class="ghost" data-act="guide">작성 가이드</button><button class="ghost" data-act="import-cancel">취소</button></span></div>
      <div class="tpl-path"><span>${esc(dir)}</span><button class="ghost" data-act="import-pick">폴더 바꾸기</button></div>
      ${error ? `<div class="tpl-error">${esc(error)} · 파일 위치와 형식은 <b>작성 가이드</b>를 보세요</div>` : `
        <div class="tpl-rows">${rows}</div>
        <div class="tpl-sum">템플릿 ${items.length}개 · 새로 ${counts.new} · 바뀜 ${counts.changed} · 같음 ${counts.same} · 바뀐 것은 본문만 바꾸고 기록은 남겨요</div>`}
      <div class="tpl-act"><button class="primary" data-act="import-apply" ${importChecked.size ? '' : 'disabled'}>${importChecked.size}개 가져오기</button></div>`;
  }
  async function applyImport() {
    const picked = importScan.items.filter((i) => importChecked.has(i.code));
    for (const i of picked) {
      const t = templates.find((x) => x.code === i.code);
      if (t) Object.assign(t, { title: i.title, stage: i.stage, stageName: i.stageName, goalSec: i.goalSec, body: i.body, source: i.source });
      else templates.push({ id: newId(), ...i, attempts: [], streak: 0, graduatedAt: null });
    }
    try { localStorage.setItem(STORAGE_TPL_DIR, importScan.dir); } catch (_) {}
    await persist();
    selectedId = templates.find((x) => x.code === picked[0]?.code)?.id ?? selectedId;
    view = 'detail';
    render();
    ctx.showStatus(`템플릿 ${picked.length}개 가져옴`);
  }


  // =========================================================
  // 작성 가이드 — 템플릿.md 형식 + AI에게 붙여넣을 프롬프트
  // =========================================================
  const GUIDE_SKELETON = [
    '# STAGE 6 템플릿 — 주제 이름',
    '',
    '> 설명·진도표는 자유롭게 (가져올 때 무시됨)',
    '',
    '## T6-1. 템플릿 이름 (1분 30초)',
    '',
    '```cpp',
    '// 백지에서 복원할 코드',
    '```',
    '',
    '> 요령·주의 (본문에 안 들어감)',
    '',
    '## T6-2. 다음 템플릿 (2분)',
    '',
    '```cpp',
    '// ...',
    '```',
    '',
  ].join('\n');

  const GUIDE_PROMPT = [
    '너는 코딩테스트 암기용 "템플릿.md" 파일을 만드는 도우미야.',
    'Scratchpad 앱이 이 파일을 자동으로 가져가서 "보고 따라치기 → 백지 복원 → 채점" 연습에 쓴다.',
    '아래 형식 규칙을 한 글자도 어기지 말고 마크다운 파일 하나를 만들어 줘.',
    '',
    '[주제] (여기에 적기. 예: C++ BFS/DFS 그래프 탐색)',
    '[STAGE 번호] (여기에 적기. 예: 4)',
    '[언어] C++',
    '[추가 제약] (있으면 적기. 예: bits/stdc++.h 금지, auto [a, b] 금지, 함수형 solution 제출)',
    '',
    '## 형식 규칙 (앱이 이 규칙으로 파싱함)',
    '1. 첫 줄은 `# STAGE {번호} 템플릿 — {주제 이름}` (가운데는 긴 대시 —)',
    '2. 템플릿마다 헤더 한 줄: `## T{STAGE}-{번호}. {이름} ({목표 시간})`',
    '   - 번호 뒤 마침표(.) 필수. 예: `## T4-1. BFS 격자 최단거리 (3분)`',
    '   - 목표 시간은 괄호 안에 "30초", "1분", "1분 30초", "3분" 형식',
    '   - 번호는 1부터 차례대로, 중복 금지',
    '3. 헤더 바로 아래에 복원할 코드를 ```cpp 코드 블록 **딱 하나**로 둔다',
    '4. 한 템플릿 = 한 개념. 다른 개념은 반드시 새 `##` 헤더로 나눈다',
    '   - `###` 소제목 아래에 코드 블록을 두지 않는다 (앞 템플릿에 합쳐져 버림)',
    '5. 코드 블록 밖의 설명은 `>` 인용문으로만 쓴다 (가져올 때 무시됨)',
    '6. 템플릿이 아닌 `##` 섹션(예: `## 규칙`)에는 코드 블록을 넣지 않는다',
    '',
    '## 내용 규칙',
    '- 문제 풀이 전체가 아니라, 여러 문제에 반복해서 쓰는 **최소 골격**만 (5~25줄)',
    '- 백지에서 외워 칠 수 있게 변수명은 짧고 관용적으로 (n, m, dr, dc, vis, q ...)',
    '- 핵심 이유는 코드 주석으로 달아도 된다 (채점할 때 주석은 무시됨)',
    '- 목표 시간 기준: 5줄 이하 30초 · 12줄 이하 1분 · 20줄 이하 2분 · 그 이상 3분',
    '- 템플릿 4~7개. 쉬운 것 → 어려운 것 순서',
    '',
    '## 출력',
    '- 설명 없이 마크다운 원문만 출력한다',
    '- 저장 위치 안내: `stage{번호}-{주제}/템플릿.md` (파일 이름은 정확히 "템플릿.md")',
  ].join('\n');

  const GUIDE_HTML = `
    <div class="tpl-dhead"><div><b>템플릿.md 작성 가이드</b>
      <span>레포에서 가져오기가 이 규칙으로 파일을 읽어요</span></div>
      <button class="ghost" data-act="guide-close">닫기</button></div>
    <div class="guide">
      <h4>1. 파일 위치</h4>
      <ul>
        <li>파일 이름은 정확히 <code>템플릿.md</code></li>
        <li>가져오기로 고른 폴더 <b>바로 안</b>, 또는 <code>stage</code>로 시작하는 하위 폴더 안 (예: <code>coding-test/stage4-BFS-DFS-그래프/템플릿.md</code>)</li>
      </ul>

      <h4>2. 뼈대 <button class="ghost" data-act="copy-skeleton">복사</button></h4>
      <pre id="guide-skeleton"></pre>

      <h4>3. 읽는 규칙</h4>
      <table>
        <tr><td><code># … — 이름</code></td><td>파일 첫 제목. 긴 대시(—) 뒤가 STAGE 이름. ★ 뒤 메모는 버림</td></tr>
        <tr><td><code>## T4-1. 이름 (3분)</code></td><td>템플릿 하나 시작. <b>T + 숫자 - 숫자 + 마침표</b> 필수. 앞 숫자가 STAGE</td></tr>
        <tr><td><code>(1분 30초)</code></td><td>목표 시간. 분·초가 든 첫 괄호. <code>(암송, 30초)</code>도 됨. 없으면 1분</td></tr>
        <tr><td>코드 블록</td><td>헤더부터 다음 <code>#</code>·<code>##</code> 전까지의 블록을 전부 모아 본문으로. 여러 개면 빈 줄로 이어 붙임</td></tr>
        <tr><td>인용문·표·설명</td><td>본문에 안 들어감</td></tr>
        <tr><td>코드 안 주석</td><td>따라치기 화면엔 보이고, <b>채점할 땐 무시</b></td></tr>
      </table>

      <h4>4. 흔한 실수</h4>
      <ul>
        <li><b><code>###</code> 아래 코드 블록</b> — 섹션을 끊지 않아서 앞 템플릿에 합쳐져요. 다른 개념이면 새 <code>##</code>로</li>
        <li><b>번호 뒤 마침표 빠짐</b> (<code>## T4-1 BFS</code>) — 템플릿으로 인식 안 돼요</li>
        <li><b>코드 블록 없는 헤더</b> — 건너뛰어요</li>
        <li><b>번호 중복</b> — 앱은 번호로 같은 템플릿인지 판단해요. 중복되면 뒤의 것이 앞의 것을 덮어요</li>
        <li><b>본문을 고친 뒤</b> — 가져오기를 다시 누르면 “본문 바뀜”으로 떠요. 본문만 바꾸고 기록은 남아요</li>
      </ul>

      <h4>5. AI에게 만들어 달라고 하기 <button class="primary" data-act="copy-prompt">프롬프트 복사</button></h4>
      <p>아래를 복사해서 Claude·ChatGPT 같은 AI에게 붙여넣고, <b>[주제] [STAGE 번호] [추가 제약]</b> 칸만 채우세요. 받은 결과를 <code>stage번호-주제/템플릿.md</code>로 저장하고 가져오기를 누르면 돼요.</p>
      <pre id="guide-prompt"></pre>

      <h4>6. Claude Code를 쓴다면</h4>
      <p>레포의 <code>scratchpad-template</code> 스킬이 위 규칙대로 템플릿.md를 쓰고 검사까지 해요. 직접 검사하려면 <code>node scripts/check-template.js &lt;폴더&gt;</code> — 가져오기와 같은 파서로 읽어서 형식 경고를 보여줘요.</p>
    </div>`;

  function openGuide() {
    view = 'guide';
    render();
  }
  function renderGuide() {
    const box = $('tpl-guide');
    box.innerHTML = GUIDE_HTML;
    $('guide-skeleton').textContent = GUIDE_SKELETON;
    $('guide-prompt').textContent = GUIDE_PROMPT;
  }
  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      ctx.showStatus(label + ' 복사됨');
    } catch (_) {
      ctx.showStatus('복사 실패 · 직접 드래그해서 복사하세요');
    }
  }

  // ---------- 오버레이 이벤트 ----------
  $('tpl-search').addEventListener('input', renderList);
  $('tpl-list').addEventListener('click', (e) => {
    const b = e.target.closest('.tpl-item');
    if (!b) return;
    selectedId = b.dataset.id;
    view = 'detail';
    confirmDeleteId = null;
    render();
  });
  $('tpl-new').addEventListener('click', () => openEdit(null));
  $('tpl-import-open').addEventListener('click', () => openImport());
  $('tpl-guide-open').addEventListener('click', openGuide);
  $('tpl-f-cancel').addEventListener('click', () => { view = 'detail'; render(); });
  $('tpl-f-save').addEventListener('click', saveEdit);
  $('tpl-import').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-code]');
    if (!cb) return;
    if (cb.checked) importChecked.add(cb.dataset.code); else importChecked.delete(cb.dataset.code);
    renderImport();
  });
  $('tpl-main').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const t = byId(selectedId);
    switch (b.dataset.act) {
      case 'close': closeLibrary(); break;
      case 'follow': closeLibrary(); showFollow(t); break;
      case 'drill': closeLibrary(); startDrill(t); break;
      case 'edit': openEdit(t.id); break;
      case 'delete': confirmDeleteId = t.id; render(); break;
      case 'delete-cancel': confirmDeleteId = null; render(); break;
      case 'delete-yes': deleteTemplate(t.id); break;
      case 'import-cancel': view = 'detail'; render(); break;
      case 'guide': openGuide(); break;
      case 'guide-close': view = 'detail'; render(); break;
      case 'copy-skeleton': copyText(GUIDE_SKELETON, '뼈대'); break;
      case 'copy-prompt': copyText(GUIDE_PROMPT, 'AI 프롬프트'); break;
      case 'import-pick': {
        const dir = await window.tpl.pickDir(importScan && importScan.dir);
        if (dir) openImport(dir);
        break;
      }
      case 'import-apply': applyImport(); break;
      default: break;
    }
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeLibrary(); });

  // =========================================================
  // 보고 따라치기 — 메모 패널 자리에 템플릿 (읽기 전용)
  // =========================================================
  const memoTitle = $('memo-title');
  const memoActions = $('memo-actions');
  const MEMO_TITLE_DEFAULT = memoTitle.textContent;
  const MEMO_ACTIONS_DEFAULT = memoActions.innerHTML;

  function showFollow(t) {
    if (!t) return;
    followId = t.id;
    followModel.setValue(t.body);
    memoEditor.setModel(followModel);
    memoEditor.updateOptions({ readOnly: true });
    memoTitle.textContent = `${t.code} · ${t.title} · ${fmtGoal(t.goalSec)}`;
    memoActions.innerHTML = '<button id="memo-drill" class="primary">백지 복원 Ctrl+R</button>' +
      '<button id="memo-back" class="ghost">메모로</button>';
    $('memo-drill').onclick = () => startDrill(byId(followId));
    $('memo-back').onclick = () => endFollow();
    ctx.setMemoOpen(true, true);
    ctx.showStatus(`${t.code} 보고 따라치기 · Ctrl+X로 가리기 · Ctrl+R로 백지 복원`);
  }
  function endFollow(silent) {
    followId = null;
    memoEditor.setModel(memoModel);
    memoEditor.updateOptions({ readOnly: false });
    memoTitle.textContent = MEMO_TITLE_DEFAULT;
    memoActions.innerHTML = MEMO_ACTIONS_DEFAULT;
    if (!silent) ctx.showStatus('메모로 돌아옴');
  }

  // =========================================================
  // 백지 복원 — 템플릿 가리고 빈 에디터 + 타이머
  // =========================================================
  const drillbar = $('drillbar');
  function tickDrill() {
    const t = byId(drill.id);
    const sec = Math.floor((Date.now() - drill.startedAt) / 1000);
    $('drill-clock').textContent = clock(sec);
    const over = sec > t.goalSec;
    $('drill-bar').style.width = Math.min(100, (sec / t.goalSec) * 100) + '%';
    drillbar.classList.toggle('over', over);
  }
  function startDrill(t) {
    if (!t) { ctx.showStatus('복원할 템플릿을 먼저 고르세요 · Ctrl+T'); return; }
    if (drill) clearInterval(drill.timer);
    if (followId && followId !== t.id) endFollow(true); // 다른 템플릿을 복원하면 따라치기 대상도 바꾼다
    if (stash === null) stash = editor.getValue();
    const prevAc = drill ? drill.prevAc : ctx.isAutocomplete();
    ctx.setAutocomplete(false, true);
    ctx.setMemoOpen(false, true);
    editor.setValue('');
    drill = { id: t.id, startedAt: Date.now(), timer: null, prevAc };
    $('drill-name').textContent = `${t.code} ${t.title}`;
    $('drill-goal').textContent = '/ 목표 ' + clock(t.goalSec);
    document.body.classList.add('drilling');
    tickDrill();
    drill.timer = setInterval(tickDrill, 250);
    editor.layout();
    editor.focus();
    ctx.showStatus('백지 복원 시작 · 자동완성 OFF · ⌘⇧↵ 제출 · Esc 포기');
  }
  function endDrill() {
    if (!drill) return;
    clearInterval(drill.timer);
    ctx.setAutocomplete(drill.prevAc, true);
    drill = null;
    editor.setValue(stash ?? '');
    stash = null;
    document.body.classList.remove('drilling');
    closeResult();
    if (followId) ctx.setMemoOpen(true, true); // 따라치기 중이었으면 템플릿을 다시 보여준다
    editor.layout();
    editor.focus();
  }
  function abortDrill() {
    endDrill();
    ctx.showStatus('복원 포기 · 기록은 남지 않았어요');
  }

  // ---------- 채점 결과 ----------
  const resultOverlay = $('result-overlay');
  let diffEditor = null;
  let diffModels = [];
  function closeResult() {
    resultOpen = false;
    resultOverlay.classList.remove('open');
  }
  async function submitDrill() {
    if (!drill || resultOpen) return;
    clearInterval(drill.timer);
    const t = byId(drill.id);
    const sec = Math.max(1, Math.round((Date.now() - drill.startedAt) / 1000));
    const r = judge(editor.getValue(), t.body);
    const timeOk = sec <= t.goalSec;
    const ok = r.contentOk && timeOk;
    t.attempts = t.attempts || [];
    t.attempts.push({ at: new Date().toISOString(), sec, ok, contentOk: r.contentOk, missing: r.missing, extra: r.extra });
    t.streak = ok ? (t.streak || 0) + 1 : 0; // 내용이 맞아도 시간 초과면 끊는다
    let justGraduated = false;
    if (ok && t.streak >= STREAK_TO_GRADUATE && !t.graduatedAt) {
      t.graduatedAt = new Date().toISOString();
      justGraduated = true;
    }
    persist();

    // diff: 왼쪽 = 내 코드, 오른쪽 = 템플릿 (둘 다 주석 제거·#include 정렬된 비교용 모습)
    const oldModels = diffModels;
    diffModels = [
      monaco.editor.createModel(r.mineLines.join('\n'), 'cpp'),
      monaco.editor.createModel(r.answerLines.join('\n'), 'cpp'),
    ];
    resultOpen = true;
    resultOverlay.classList.add('open');
    if (!diffEditor) {
      diffEditor = monaco.editor.createDiffEditor($('diff'), {
        theme: 'vs-dark', readOnly: true, originalEditable: false, renderSideBySide: true,
        automaticLayout: true, minimap: { enabled: false }, renderOverviewRuler: false,
        fontSize: 13, fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        scrollBeyondLastLine: false, ignoreTrimWhitespace: true,
      });
    }
    diffEditor.setModel({ original: diffModels[0], modified: diffModels[1] });
    oldModels.forEach((m) => m.dispose()); // 새 모델을 붙인 뒤에 버린다
    diffEditor.layout();

    const text = $('verdict-text');
    const meta = $('verdict-meta');
    text.className = 'big ' + (ok ? 'ok' : 'bad');
    if (ok) text.textContent = justGraduated ? '성공 · 졸업 ✓' : '성공';
    else if (r.contentOk) text.textContent = '시간 초과 · 내용은 맞음';
    else text.textContent = `실패 · ${Math.max(r.missing, r.extra)}줄 다름`;
    meta.textContent = `${sec}초 / 목표 ${t.goalSec}초 · ` +
      (ok ? `연속 ${Math.min(t.streak, STREAK_TO_GRADUATE)}/${STREAK_TO_GRADUATE}` : '연속 기록 0으로');
    $('r-next').focus();
  }
  function nextTemplate(id) {
    const list = sorted(templates);
    const i = list.findIndex((t) => t.id === id);
    return list[i + 1] || null;
  }
  $('drill-submit').addEventListener('click', submitDrill);
  $('drill-abort').addEventListener('click', abortDrill);
  $('r-again').addEventListener('click', () => { const t = byId(drill.id); closeResult(); startDrill(t); });
  $('r-list').addEventListener('click', () => { const id = drill.id; endDrill(); openLibrary(id); });
  $('r-next').addEventListener('click', () => {
    const next = nextTemplate(drill.id);
    endDrill();
    if (next) showFollow(next); else ctx.showStatus('마지막 템플릿이에요');
  });
  $('r-close').addEventListener('click', endDrill);

  // =========================================================
  // 키 처리 — renderer.js 전역 keydown(capture)의 맨 앞에서 호출. 처리했으면 true
  // =========================================================
  function onKeydown(e) {
    if ($('shortcuts-overlay').classList.contains('open')) return false;
    const key = e.key.toLowerCase();
    const stop = () => { e.preventDefault(); e.stopPropagation(); return true; };

    if (e.key === 'Escape') {
      if (resultOpen) { endDrill(); return stop(); }
      if (isLibOpen()) {
        if (view !== 'detail') { view = 'detail'; render(); } else closeLibrary();
        return stop();
      }
      if (drill) { abortDrill(); return stop(); }
      return false;
    }
    // Cmd+Shift+Enter — 복원 제출
    if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
      if (drill) submitDrill();
      return stop();
    }
    if (!e.ctrlKey || e.metaKey || e.altKey) return false;
    if (key === 't') {
      if (isLibOpen()) closeLibrary(); else openLibrary();
      return stop();
    }
    if (key === 'r') {
      if (drill) { ctx.showStatus('이미 복원 중이에요 · ⌘⇧↵ 제출 · Esc 포기'); return stop(); }
      const target = byId(followId) || (isLibOpen() && byId(selectedId));
      if (target) { closeLibrary(); startDrill(target); } else openLibrary();
      return stop();
    }
    if (key === 'x' && drill) {
      ctx.showStatus('복원 중엔 템플릿을 열 수 없어요');
      return stop();
    }
    return false;
  }

  window.tpl.load().then((list) => {
    templates = list;
    selectedId = sorted(templates)[0]?.id ?? null;
  });

  return {
    onKeydown,
    // 복원 중엔 왼쪽 에디터가 비어 있으므로, 자동 저장은 보관해 둔 원래 코드를 저장한다
    persistedCode: () => (stash !== null ? stash : editor.getValue()),
  };
};
