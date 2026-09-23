#!/usr/bin/env node
// 템플릿.md 형식 검사 — 앱의 "레포에서 가져오기"와 같은 파서로 읽어 본다.
//   node scripts/check-template.js [--fix] <템플릿.md 또는 폴더> [...]
// 폴더를 주면 그 안의 템플릿.md와 stage*/템플릿.md를 전부 검사한다.
// 템플릿 코드가 앱 포맷(Cmd+S, .clang-format)과 다르면 경고하고, --fix면 파일을 그 모양으로 고친다.
// 경고가 하나라도 있으면 종료 코드 1.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findTemplateFiles, parseTemplateMd } = require('../template-parser');

const fmtGoal = (sec) => {
  const m = Math.floor(sec / 60), s = sec % 60;
  if (!m) return s + '초';
  return s ? `${m}분 ${s}초` : `${m}분`;
};

// ---- 앱 포맷 검사 (clang-format이 없으면 건너뜀) ----
const STYLE = 'file:' + path.join(__dirname, '..', '.clang-format');
const clangFormat = (() => {
  const r = spawnSync('/usr/bin/xcrun', ['--find', 'clang-format'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  const w = spawnSync('/usr/bin/which', ['clang-format'], { encoding: 'utf8' });
  return w.status === 0 && w.stdout.trim() ? w.stdout.trim() : null;
})();
function formatCpp(code) {
  const r = spawnSync(clangFormat, ['--style=' + STYLE, '--assume-filename=a.cpp'], { input: code + '\n', encoding: 'utf8' });
  return r.status === 0 ? r.stdout.replace(/\n+$/, '') : null;
}
// ## T 헤더 아래 ```cpp 블록(여러 개면 전부)을 앱 포맷으로 — 반환: { text, changed: [{ code, line }] }
function formatFile(text) {
  const lines = text.split('\n');
  const out = [];
  const changed = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^## (T\d+-\d+)\./);
    if (h) cur = h[1];
    else if (/^#{1,2}\s/.test(line)) cur = null;
    if (cur && line.startsWith('```cpp')) {
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith('```')) j++;
      if (j >= lines.length) { out.push(...lines.slice(i)); break; } // 안 닫힌 블록은 파서가 경고
      const code = lines.slice(i + 1, j).join('\n');
      const formatted = formatCpp(code);
      if (formatted !== null && formatted !== code) changed.push({ code: cur, line: i + 1 });
      out.push(line, ...(formatted ?? code).split('\n'), lines[j]);
      i = j; // 한 템플릿에 코드 블록이 여러 개여도 전부 검사 (앱은 이어 붙여 본문으로 씀)
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), changed };
}

const argv = process.argv.slice(2);
const fix = argv.includes('--fix');
const args = argv.filter((a) => a !== '--fix');
if (!args.length) {
  console.error('사용법: node scripts/check-template.js [--fix] <템플릿.md 또는 폴더> [...]');
  process.exit(2);
}

let files = [];
for (const a of args) {
  const p = path.resolve(a);
  if (!fs.existsSync(p)) { console.error(`없는 경로: ${a}`); process.exit(2); }
  files = files.concat(fs.statSync(p).isDirectory() ? findTemplateFiles(p) : [p]);
}
if (!files.length) {
  console.error('템플릿.md를 찾지 못했어요 (파일 이름은 정확히 "템플릿.md", 폴더는 stage로 시작)');
  process.exit(1);
}

let total = 0;
let warnCount = 0;
if (!clangFormat) console.log('clang-format이 없어 앱 포맷 검사는 건너뛰어요 (xcode-select --install)');
for (const f of files) {
  let text = fs.readFileSync(f, 'utf8');
  let fixed = [];
  if (clangFormat) {
    const r = formatFile(text);
    if (fix && r.changed.length) { fs.writeFileSync(f, r.text); text = r.text; fixed = r.changed; }
    else if (!fix) fixed = r.changed;
  }
  const { items, warnings } = parseTemplateMd(text, f);
  for (const c of fixed) {
    if (fix) console.log(`  ✎ ${c.code}: 앱 포맷(Cmd+S)으로 정리함`);
    else warnings.push({ line: c.line, msg: `${c.code}: 코드가 앱 포맷(Cmd+S)과 달라요 — --fix로 정리` });
  }
  total += items.length;
  warnCount += warnings.length;
  console.log(`\n${path.relative(process.cwd(), f)} — 템플릿 ${items.length}개`);
  for (const it of items) {
    const lines = it.body.split('\n').length;
    console.log(`  ${it.code.padEnd(6)} ${fmtGoal(it.goalSec).padEnd(7)} ${String(lines).padStart(2)}줄  ${it.title}`);
  }
  for (const w of warnings) console.log(`  ⚠ ${w.line ? w.line + '줄: ' : ''}${w.msg}`);
}
console.log(`\n합계: 템플릿 ${total}개 · 경고 ${warnCount}개`);
process.exit(warnCount ? 1 : 0);
