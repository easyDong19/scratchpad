#!/bin/zsh
# 더블클릭으로 스크래치패드 실행
cd "$(dirname "$0")"
nohup npx electron . >/dev/null 2>&1 &
disown
exit 0
