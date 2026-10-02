@echo off
rem osep-judge LAN-mode launcher. Keep this file ASCII-only: cmd mis-parses multibyte lines under chcp 65001.
rem All guidance text is printed by Node (scripts\tutor\server.mjs).
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [osep-judge] Node.js not found. Please install Node.js 22 LTS from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 22) { console.log('Node \u7248\u672c\u592a\u820a\u3002\u8acb\u6559\u5e2b\u5b89\u88dd Node.js 22 \u4ee5\u4e0a\uff08https://nodejs.org/ \u9078 LTS \u7248\uff09\uff0c\u518d\u555f\u52d5\u5340\u7db2\u5c0e\u5e2b\u3002'); process.exit(1); }"
if errorlevel 1 (
  pause
  exit /b 1
)
set TUTOR_LAN=1
node scripts\tutor\server.mjs
pause
