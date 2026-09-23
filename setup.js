// 첫 실행 설정 — 컴파일·자동완성에 필요한 개발 도구가 있는지 확인하고 설치를 안내한다.
// 앱을 켤 때 빠진 도구가 있으면 자동으로 뜨고, 메뉴 > 도움말 > 개발 도구 환경 확인에서도 열린다.
(function () {
  const STORAGE_SKIP = 'scratchpad.setupSkip';
  const BREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
  const GCC_INSTALL = '/opt/homebrew/bin/brew install gcc';

  const overlay = document.getElementById('setup-overlay');
  const list = document.getElementById('setup-list');
  const skip = document.getElementById('setup-skip');
  const msg = document.getElementById('setup-msg');
  const recheckBtn = document.getElementById('setup-recheck');

  let startEnv = null; // 앱을 켰을 때의 상태 — clangd에 영향 주는 변화가 있으면 다시 붙인다
  let env = null;

  const isReady = (e) => e.clangxx && e.clangd && e.gcc;

  function el(tag, props, ...children) {
    const n = document.createElement(tag);
    Object.assign(n, props);
    for (const c of children) n.append(c);
    return n;
  }

  function button(label, cls, onClick) {
    const b = el('button', { textContent: label, className: cls || '' });
    b.addEventListener('click', onClick);
    return b;
  }

  function cmdRow(cmd) {
    const copy = button('복사', '', async () => {
      await navigator.clipboard.writeText(cmd);
      copy.textContent = '복사됨 ✓';
      setTimeout(() => { copy.textContent = '복사'; }, 1500);
    });
    return el('div', { className: 'setup-cmd' }, el('code', { textContent: cmd }), copy);
  }

  function item(ok, title, note, desc, ...extra) {
    const t = el('div', { className: 'title', textContent: title });
    if (note) t.append(el('small', { textContent: note }));
    return el('div', { className: 'setup-item ' + (ok ? 'ok' : 'missing') },
      el('span', { className: 'mark', textContent: ok ? '✓' : '✗' }),
      el('div', { className: 'body' }, t, el('div', { className: 'desc', textContent: desc }), ...extra));
  }

  function render() {
    list.replaceChildren();
    list.append(item(true, '에디터 · 메모 패널 · 템플릿 드릴', '바로 사용 가능',
      '타이핑 연습에 필요한 건 앱에 모두 들어 있어요.'));

    const xcodeOk = env.clangxx && env.clangd;
    list.append(xcodeOk
      ? item(true, 'Xcode 명령줄 도구', 'clang++ · clangd', '컴파일러와 자동완성 엔진이 준비됐어요.')
      : item(false, 'Xcode 명령줄 도구', 'clang++ · clangd',
        '컴파일러(clang++)와 자동완성 엔진(clangd)이에요. 버튼을 누르면 macOS 설치 창이 뜹니다 — "설치"를 누르고 몇 분 기다리세요.',
        el('div', { className: 'setup-actions' },
          button('설치 시작', 'primary', () => {
            window.env.installXcode();
            msg.textContent = '설치 창에서 "설치"를 누르고, 끝나면 다시 확인을 눌러 주세요';
          }))));

    if (env.gcc) {
      list.append(item(true, 'GCC 헤더', 'GCC ' + env.gcc, '#include <bits/stdc++.h>를 쓸 수 있어요.'));
    } else {
      const steps = [];
      if (!env.brew) {
        steps.push(el('div', { className: 'setup-step', textContent: '1. Homebrew 설치 — 터미널에 붙여넣고 엔터 (Mac 로그인 비밀번호를 물어봐요)' }), cmdRow(BREW_INSTALL));
        steps.push(el('div', { className: 'setup-step', textContent: '2. GCC 설치 — Homebrew 설치가 끝나면 이어서' }), cmdRow(GCC_INSTALL));
      } else {
        steps.push(el('div', { className: 'setup-step', textContent: '터미널에 붙여넣고 엔터 — 몇 분 걸려요' }), cmdRow(GCC_INSTALL));
      }
      list.append(item(false, 'GCC 헤더', 'Homebrew로 설치',
        '코딩테스트 사이트처럼 #include <bits/stdc++.h>를 쓰려면 필요해요. 비밀번호가 필요해서 앱이 대신 설치할 수 없어요.',
        ...steps,
        el('div', { className: 'setup-actions' }, button('터미널 열기', '', () => window.env.openTerminal()))));
    }

    recheckBtn.textContent = isReady(env) ? '완료' : '다시 확인';
  }

  function open() {
    render();
    msg.textContent = '';
    try { skip.checked = localStorage.getItem(STORAGE_SKIP) === '1'; } catch (_) {}
    overlay.classList.add('open');
    recheckBtn.focus();
  }

  function close() {
    try { localStorage.setItem(STORAGE_SKIP, skip.checked ? '1' : '0'); } catch (_) {}
    overlay.classList.remove('open');
    if (window.focusEditor) window.focusEditor();
  }

  async function recheck() {
    env = await window.env.check();
    const changed = env.clangd !== startEnv.clangd || env.gcc !== startEnv.gcc;
    if (changed) {
      // 새로 생긴 도구로 clangd를 다시 띄우고 창을 새로 고친다 (작성 중인 코드는 자동 저장됨)
      try { localStorage.setItem(STORAGE_SKIP, skip.checked ? '1' : '0'); } catch (_) {}
      msg.textContent = '적용하는 중…';
      await window.env.apply();
      return;
    }
    if (isReady(env)) { close(); return; }
    render();
    msg.textContent = '아직 설치되지 않은 도구가 있어요';
  }

  recheckBtn.addEventListener('click', recheck);
  document.getElementById('setup-later').addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  }, true);
  window.ui.onShowSetup(() => { if (env) open(); });

  window.env.check().then((e) => {
    startEnv = env = e;
    let skipped = false;
    try { skipped = localStorage.getItem(STORAGE_SKIP) === '1'; } catch (_) {}
    if (!isReady(env) && !skipped) open();
  });
})();
