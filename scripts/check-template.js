#!/usr/bin/env node
// 템플릿.md 형식 검사 — 앱의 "레포에서 가져오기"와 같은 파서로 읽어 본다.
//   node scripts/check-template.js <템플릿.md 또는 폴더> [...]
// 폴더를 주면 그 안의 템플릿.md와 stage*/템플릿.md를 전부 검사한다.
// 경고가 하나라도 있으면 종료 코드 1.
const fs = require('fs');
const path = require('path');
const { findTemplateFiles, parseTemplateMd } = require('../template-parser');

const fmtGoal = (sec) => {
  const m = Math.floor(sec / 60), s = sec % 60;
  if (!m) return s + '초';
  return s ? `${m}분 ${s}초` : `${m}분`;
};

const args = process.argv.slice(2);
if (!args.length) {
  console.error('사용법: node scripts/check-template.js <템플릿.md 또는 폴더> [...]');
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
for (const f of files) {
  const { items, warnings } = parseTemplateMd(fs.readFileSync(f, 'utf8'), f);
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
