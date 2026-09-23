// 템플릿.md 파서 — 앱의 "레포에서 가져오기"와 scripts/check-template.js가 같이 쓴다.
// Electron에 의존하지 않는다 (node만으로 실행 가능).
const fs = require('fs');
const path = require('path');

const nfc = (s) => s.normalize('NFC'); // macOS 파일명은 NFD로 올 수 있다
const TEMPLATE_FILE = '템플릿.md';
const HEADING_RE = /^##\s+(T(\d+)-\d+)\.\s+(.*)$/;
const DEFAULT_GOAL_SEC = 60;

// 고른 폴더 바로 안의 템플릿.md + stage* 하위 폴더 안의 템플릿.md
function findTemplateFiles(dir) {
  const pick = (d) => fs.readdirSync(d).find((f) => nfc(f) === TEMPLATE_FILE);
  const out = [];
  const direct = pick(dir);
  if (direct) out.push(path.join(dir, direct));
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^stage\d+/i.test(d.name)) continue;
    const f = pick(path.join(dir, d.name));
    if (f) out.push(path.join(dir, d.name, f));
  }
  return out;
}

// "## T0-1. 고정 헤더 + typedef (30초)" → { code, stage, title, goalSec, hasGoal }
function parseHeading(line) {
  const m = line.match(HEADING_RE);
  if (!m) return null;
  const rest = m[3];
  let title = rest.trim();
  let goalSec = DEFAULT_GOAL_SEC;
  const g = [...rest.matchAll(/\(([^()]*)\)/g)].find((x) => /\d+\s*(분|초)/.test(x[1]));
  if (g) {
    const mm = g[1].match(/(\d+)\s*분/);
    const ss = g[1].match(/(\d+)\s*초/);
    goalSec = (mm ? +mm[1] * 60 : 0) + (ss ? +ss[1] : 0);
    title = rest.slice(0, g.index).trim();
  }
  return { code: m[1], stage: +m[2], title, goalSec, hasGoal: !!g };
}

// 반환: { items, warnings }. items는 앱이 가져가는 템플릿, warnings는 형식 문제
function parseTemplateMd(text, source) {
  const lines = text.split(/\r?\n/);
  const warnings = [];
  const warn = (lineNo, msg) => warnings.push({ line: lineNo, msg });

  const h1Index = lines.findIndex((l) => /^#\s/.test(l));
  const h1 = h1Index >= 0 ? lines[h1Index] : '';
  const stageName = (h1.split('—')[1] || '').replace(/★.*$/, '').trim();
  const h1Stage = (h1.match(/STAGE\s*(\d+)/i) || [])[1];
  if (h1Index < 0) warn(1, '파일 제목(# ...)이 없어요. STAGE 이름이 비어요');
  else if (!stageName) warn(h1Index + 1, '제목에 긴 대시(—)가 없어서 STAGE 이름을 못 읽어요. 예: # STAGE 4 템플릿 — BFS / DFS');

  const items = [];
  let cur = null;
  let inFence = false;
  let block = [];
  let subheadLine = 0; // 현재 템플릿 안에서 ### 소제목을 본 줄
  const flush = () => {
    if (!cur) return;
    if (cur.blocks.length) {
      const { hasGoal, ...head } = cur.head;
      items.push({ ...head, stageName, body: cur.blocks.join('\n\n'), source });
    } else {
      warn(cur.line, `${cur.head.code}: 코드 블록이 없어서 건너뛰어요`);
    }
  };

  lines.forEach((line, i) => {
    const no = i + 1;
    if (!inFence && /^#{1,2}\s/.test(line)) {
      flush();
      subheadLine = 0;
      const head = parseHeading(line);
      cur = head ? { head, blocks: [], line: no } : null;
      if (head) {
        if (!head.hasGoal) warn(no, `${head.code}: 목표 시간 괄호가 없어서 1분으로 들어가요. 예: (1분 30초)`);
        if (h1Stage !== undefined && String(head.stage) !== h1Stage) {
          warn(no, `${head.code}: 파일 제목은 STAGE ${h1Stage}, 템플릿 번호는 STAGE ${head.stage}로 서로 달라요`);
        }
      } else if (/^##\s+T\d/i.test(line)) {
        warn(no, '템플릿 헤더로 보이는데 형식이 달라서 건너뛰어요. "## T4-1. 이름 (3분)"처럼 번호 뒤에 마침표');
      }
      return;
    }
    if (!inFence && cur && /^#{3,}\s/.test(line)) { subheadLine = no; return; }
    if (/^```/.test(line)) {
      if (!inFence && cur && subheadLine) {
        warn(no, `${cur.head.code}: ### 소제목(${subheadLine}줄) 아래 코드 블록이 이 템플릿에 합쳐져요. 다른 개념이면 새 ## 헤더로 나누세요`);
        subheadLine = 0;
      }
      if (inFence && cur) cur.blocks.push(block.join('\n').replace(/\s+$/, ''));
      inFence = !inFence;
      block = [];
      return;
    }
    if (inFence) block.push(line);
  });
  if (inFence) warn(lines.length, '코드 블록(```)이 닫히지 않았어요');
  flush();

  const seen = new Map();
  for (const it of items) {
    if (seen.has(it.code)) warn(0, `${it.code}가 두 번 나와요. 가져올 때 뒤의 것이 앞의 것을 덮어써요`);
    seen.set(it.code, true);
  }
  return { items, warnings };
}

module.exports = { nfc, TEMPLATE_FILE, findTemplateFiles, parseHeading, parseTemplateMd };
