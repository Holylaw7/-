@echo off
chcp 65001 >nul
title 启用「允许用户脚本」并启动调试窗口

rem  %~dp0 是本 .cmd 所在目录（<根>\_tools\），上一级即项目根
set ROOT=%~dp0..
set MIRROR=%ROOT%\_edge-debug-profile
set PORT=9222
set EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
if not exist "%EDGE%" set EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe

echo.
echo ============================================================
echo   启用「允许用户脚本」+ 启动调试窗口
echo ============================================================
echo.
echo   为什么需要这一步：
echo     Edge 154 使用 MV3 扩展规范，篡改猴需要用户手动授权
echo     「允许用户脚本 / Allow User Scripts」权限，否则
echo     里面所有脚本都不会执行（表现为：已启用，但从未运行）。
echo.
echo   操作提示：启动后我会自动打开扩展页，
echo   请找到「篡改猴 / Tampermonkey」-「详细信息」，
echo   把「允许用户脚本」开关打开。
echo.
pause

if not exist "%MIRROR%" (
  echo   [错误] 缺少镜像配置，请先运行: node _tools\mirror-and-launch.js
  pause
  exit /b 1
)

REM 已在运行则直接打开扩展页
powershell -NoProfile -Command "try { $null = Invoke-WebRequest 'http://127.0.0.1:%PORT%/json/version' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto OPENEXT

tasklist /FI "IMAGENAME eq msedge.exe" 2>nul | find /I "msedge.exe" >nul
if not errorlevel 1 (
  echo   [重要] Edge 正在运行，需要先全部关闭才能用独立配置启动。
  choice /C YN /M "   现在关闭所有 Edge 窗口吗（可能丢失未保存内容）"
  if errorlevel 2 (
    echo   已取消。
    pause
    exit /b 0
  )
  powershell -NoProfile -Command "Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force" >nul 2>&1
  timeout /t 3 /nobreak >nul
)

echo   启动带调试端口的 Edge（镜像配置，篡改猴脚本已是最新 v1.0.3）...
start "" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%MIRROR%" --profile-directory=Default --no-first-run --no-default-browser-check --restore-last-session "edge://extensions/"

echo   等待端口就绪...
powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){ try { $r=Invoke-WebRequest 'http://127.0.0.1:%PORT%/json/version' -UseBasicParsing -TimeoutSec 2; Write-Host ('   OK  ' + ($r.Content|ConvertFrom-Json).Browser) -ForegroundColor Green; exit 0 } catch { Start-Sleep -Milliseconds 700 } }; Write-Host '   端口未就绪' -ForegroundColor Red"
goto DONE

:OPENEXT
echo   调试窗口已在运行，直接打开扩展页...
start "" "%EDGE%" "edge://extensions/"

:DONE
echo.
echo ============================================================
echo   接下来在打开的页面里做两步：
echo.
echo   1) 找到「篡改猴 / Tampermonkey」- 点「详细信息」
echo      把「允许用户脚本 / Allow User Scripts」打开
echo.
echo   2) 打开雨课堂课程页，用微信扫码登录一次
echo      （镜像配置的登录态无法从原配置继承）
echo.
echo   完成后可以运行诊断：
echo     node _tools\real-site-check.js --navigate
echo ============================================================
echo.
pause
