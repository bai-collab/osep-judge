@echo off
setlocal
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
echo ================ 區網模式 ================
echo 同教室學生電腦可用瀏覽器連到這台教師機使用導師；學生網址會在下方顯示。
echo 只在校內私人網路使用；Windows 防火牆只勾「私人網路」，不要勾「公用網路」。
echo 不要同時開連接埠轉送或通道工具，避免服務被校外連到。
echo 教師頁只能在這台電腦開：http://127.0.0.1:8612/teacher.html
echo 若無法自動判斷區網位址，請先在終端機執行 set TUTOR_LAN_IP=教師機的區網IPv4，再執行本檔。
echo 緊急停止：關閉這個視窗；或在教師頁清除 AI 金鑰，學生只剩模擬練習。
echo ==========================================
set TUTOR_LAN=1
node scripts\tutor\server.mjs
pause
