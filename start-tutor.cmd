@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node。請教師先準備 Node，再啟動本機導師。
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo Node 版本太舊。請教師使用 Node 22 或更新版本，再啟動本機導師。
  pause
  exit /b 1
)
if not exist "build\editor.html" (
  echo 找不到已建置的 build\editor.html。請帶入建置好的專案。
  pause
  exit /b 1
)
echo 教師設定頁：http://127.0.0.1:8612/teacher.html
echo 學生頁：http://127.0.0.1:8612/editor.html?turbo
echo 請保留這個服務視窗；按 Ctrl+C 可停止。
node scripts\tutor\server.mjs
pause
