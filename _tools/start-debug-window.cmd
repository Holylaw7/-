@echo off
chcp 65001 >nul
title 启动「调试用 Edge 窗口」（可被脚本工具连接）

rem  %~dp0 是本 .cmd 所在目录（<根>\_tools\），上一级即项目根
set ROOT=%~dp0..
set MIRROR=%ROOT%\_edge-debug-profile
set PORT=9222
set EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe

echo.
echo ============================================================
echo   启动调试用 Edge 窗口
echo ============================================================
echo.

if not exist "%EDGE%" set EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe
if not exist "%EDGE%" (
  echo   [错误] 找不到 msedge.exe
  pause
  exit /b 1
)

if not exist "%MIRROR%" (
  echo   [错误] 找不到镜像配置目录：%MIRROR%
  echo   请先运行：node _tools\mirror-and-launch.js
  pause
  exit /b 1
)

echo   镜像配置: %MIRROR%
echo   调试端口: %PORT%
echo.

REM 端口已开就直接提示
powershell -NoProfile -Command "try { $null = Invoke-WebRequest 'http://127.0.0.1:%PORT%/json/version' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo   [提示] 调试窗口已经在运行了，端口 %PORT% 可用。
  echo.
  pause
  exit /b 0
)

REM 需要先关掉普通 Edge：Edge 同一时刻只能有一个实例使用某份配置
tasklist /FI "IMAGENAME eq msedge.exe" 2>nul | find /I "msedge.exe" >nul
if not errorlevel 1 (
  echo   [重要] 检测到 Edge 正在运行。
  echo.
  echo   调试窗口必须使用独立配置目录启动，因此需要先关闭所有 Edge 窗口，
  echo   否则新的启动请求会被现有 Edge 接管，调试端口不会开启。
  echo.
  echo   注意：关闭 Edge 可能丢失未保存的网页内容。
  echo.
  choice /C YN /M "   现在关闭所有 Edge 窗口并继续吗（Y=是 / N=取消）"
  if errorlevel 2 (
    echo.
    echo   已取消。你可以手动关闭 Edge 后重新双击本文件。
    pause
    exit /b 0
  )
  echo.
  echo   正在关闭 Edge...
  powershell -NoProfile -Command "Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force" >nul 2>&1
  timeout /t 3 /nobreak >nul
)

echo   正在启动带调试端口的 Edge（使用你的镜像配置，登录态保留）...
start "" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%MIRROR%" --profile-directory=Default --no-first-run --no-default-browser-check --restore-last-session about:blank

echo   等待端口就绪...
powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){ try { $r=Invoke-WebRequest 'http://127.0.0.1:%PORT%/json/version' -UseBasicParsing -TimeoutSec 2; $j=$r.Content|ConvertFrom-Json; Write-Host ('   OK  ' + $j.Browser) -ForegroundColor Green; exit 0 } catch { Start-Sleep -Milliseconds 700 } }; Write-Host '   端口未能就绪' -ForegroundColor Red; exit 1"

echo.
echo ------------------------------------------------------------
echo   调试窗口已就绪。可以用的工具：
echo     node _tools\real-site-check.js --navigate      页面与脚本状态诊断
echo     node _tools\real-dom-dump.js                   真实 DOM 结构
echo     node _tools\real-persist-inject.js --watch 40  持久注入并观察
echo.
echo   关闭这个窗口即可停止调试（不影响你原来的 Edge 配置）
echo ------------------------------------------------------------
echo.
pause
