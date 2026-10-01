@echo off
chcp 65001 >nul
title 启动 Edge（带调试端口，用于真实环境测试）
echo.
echo   正在用你的 Default 配置文件启动 Edge，并开启调试端口 9222
echo   登录态 / 扩展 / 篡改猴脚本 全部保留
echo.
echo   注意：需要先关闭所有 Edge 窗口，否则端口不会生效。
echo.

tasklist /FI "IMAGENAME eq msedge.exe" 2>nul | find /I "msedge.exe" >nul
if not errorlevel 1 (
  echo   [提示] 检测到 Edge 正在运行。
  echo   请先关闭所有 Edge 窗口，然后重新双击本文件。
  echo.
  pause
  exit /b 1
)

start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\Microsoft\Edge\User Data" --profile-directory=Default --restore-last-session about:blank

echo   已启动。等待端口就绪...
timeout /t 5 /nobreak >nul

powershell -NoProfile -Command "try { $r = Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 3; Write-Host '   OK 调试端口已就绪' -ForegroundColor Green; ($r.Content | ConvertFrom-Json).Browser } catch { Write-Host '   端口未就绪，请确认 Edge 已完全退出' -ForegroundColor Red }"

echo.
echo   接下来可以执行： node _tools\real-site-check.js
echo.
pause
