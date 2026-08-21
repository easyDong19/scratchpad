# 스크래치패드 (C++ 타이핑 연습용)

맥용 미니멀 코드 에디터. 실행/디버깅 없음 — 순수 타이핑 연습용.

## 설치 (빌드된 앱)

[Releases](https://github.com/easyDong19/scratchpad/releases)에서 최신 `.dmg`를 받아 열고 `Scratchpad.app`을 `Applications` 폴더로 드래그.

ad-hoc 서명(공증 없음)이라 최초 실행 시 "확인되지 않은 개발자" 경고가 뜹니다 — **우클릭 > 열기**로 실행하거나, 안 되면:

```bash
xattr -dr com.apple.quarantine /Applications/Scratchpad.app
```

## 소스로 실행 / 빌드

```bash
npm install
npm start            # 개발 실행
npm run build        # dist/에 .app 패키징 (arm64)
npm run install:app  # /Applications에 설치
```

또는 Finder에서 `Scratchpad.command` 더블클릭.

## 단축키

| 키 | 기능 |
|---|---|
| `Cmd + Enter` | **컴파일 + 실행** — clang++(C++20)로 빌드해 하단 터미널에서 실행. 실행 중 `cin` 입력 가능 |
| `Ctrl + V` | **터미널** 열기/닫기 (터미널 안 `Ctrl+C`는 실행 중인 프로그램 중단) |
| `Cmd + /` | **단축키 모음집** 열기/닫기 (메뉴 > 도움말에서도 열림) |
| `Ctrl + Z` | **보스키** — 창 숨기기/보이기 (다른 앱을 쓰는 중에도 전역으로 동작) |
| `Ctrl + X` | **메모 패널** 열기/닫기 (정답 코드를 옆에 띄워놓고 따라 치기용) |
| `Ctrl + C` | **자동완성 켜기/끄기** — 코테 사이트(프로그래머스 등)엔 자동완성이 없으므로 실전 모드 연습용. 상태는 저장됨 |
| `Cmd + =` / `Cmd + +` | 글자 크기 키우기 (최대 40px) |
| `Cmd + -` | 글자 크기 줄이기 (최소 8px) |
| `Cmd + 0` | 글자 크기 초기화 (15px) |

## 기능

- **C++ 문법 하이라이팅** (Monaco Editor — VS Code와 동일 엔진)
- **진짜 IDE 자동완성 (clangd 언어 서버)**: VS Code C++ 확장과 동일한 clangd가 붙어 있음
  - `#include <bits/stdc++.h>` 헤더 완성, `ios_base::` / `v.` 멤버 완성, `std::` 전체
  - 함수 시그니처 도움말(파라미터 표시), 호버 문서, 실시간 문법 오류 표시
  - GCC(Homebrew gcc 15)의 libstdc++ 헤더 사용 — `bits/stdc++.h` 그대로 동작
- **자동완성 토글 (Ctrl+C)**: 끄면 자동 팝업·수동 트리거(Ctrl+Space)·파라미터 힌트가 모두 비활성 — 문법 하이라이팅과 실시간 오류 표시는 유지 (맥에서 복사는 Cmd+C라 충돌 없음)
- **메모 패널 (Ctrl+X)**: 오른쪽에 참고용 편집기를 띄워 정답 코드를 보면서 왼쪽에 따라 칠 수 있음
  - C++ 하이라이팅은 되지만 자동완성·진단은 왼쪽 편집기 전용 (메모는 순수 참고용)
  - 경계선 드래그로 폭 조절, 열림 여부·폭·내용 모두 저장돼 재실행 시 복원
  - Ctrl+X로 열어도 키보드 포커스는 왼쪽에 남아 타이핑이 끊기지 않음
- **컴파일 + 실행 (Cmd+Enter)**: 하단 터미널(xterm.js + node-pty, 진짜 PTY)에서 clang++ `-std=c++20`으로 빌드·실행
  - 대화형 `cin` 입력 지원 — 실행 중 터미널에 직접 타이핑
  - 무한 루프는 터미널 안에서 `Ctrl+C`로 중단, 높이 드래그 조절·열림 상태 저장
- 작성 내용은 자동 저장되어 재실행 시 복원됨

## Programmers 기준 설정

- 언어 표준: **C++20** (`compile_flags.txt` 및 실행 컴파일 모두 `-std=c++20`)
- 표준 라이브러리: GCC libstdc++ (`bits/stdc++.h` 사용 가능, Programmers의 g++와 같은 라이브러리 계열)
- 포맷(Cmd+S): `.clang-format` — 4칸 들여쓰기, 같은 줄 중괄호, 줄 길이 제한 없음 (Programmers 기본 `solution()` 템플릿 스타일)
- 기본 템플릿: Programmers `int solution(vector<int> numbers)` 형식

## 환경 의존성

- `/usr/bin/clangd` (Xcode Command Line Tools에 포함)
- Homebrew GCC 15 헤더 경로가 [compile_flags.txt](compile_flags.txt)에 지정됨 — GCC 버전을 올리면 이 파일의 `15`를 새 버전으로 수정

## 참고

- macOS에서 실행 취소는 `Cmd+Z`라서 `Ctrl+Z`는 보스키로만 쓰임 (편집 기능과 충돌 없음)
- `Ctrl+Z`는 전역 단축키라 이 앱이 켜져 있는 동안 다른 앱에서의 `Ctrl+Z` 입력도 가로챔
