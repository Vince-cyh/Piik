@echo off
rem Piik LAN dev launcher:  scripts\dev-lan.cmd [LAN-IP]
rem   No argument: auto-detect the primary IPv4 address.
rem   Host keeps using http://localhost:8787 (secure context for capture);
rem   colleagues join through the generated http://<LAN-IP>:8787/r/... link.
setlocal
cd /d "%~dp0\.."

rem --- Toolchains: prefer the WorkBuddy Node 24 cache, fall back to PATH ---
set "NODE24=%USERPROFILE%\.workbuddy\binaries\node\versions\24.14.0.installing.37496.__extract_temp__\node-v24.14.0-win-x64"
if exist "%NODE24%\node.exe" set "PATH=%NODE24%;%PATH%"
where node >nul 2>nul
if errorlevel 1 (echo [dev-lan] Node.js not found. Install Node 24+ ^(see .node-version^). & exit /b 1)

where go >nul 2>nul && set "GOEXE=go"
if not defined GOEXE set "GOEXE=%TEMP%\go1.26\go\bin\go.exe"
"%GOEXE%" version >nul 2>nul
if errorlevel 1 (echo [dev-lan] Go not found on PATH or at %%TEMP%%\go1.26. Install Go 1.26+. & exit /b 1)

rem --- LAN IP: argument wins, otherwise auto-detect ---
set "LAN_IP=%~1"
if not defined LAN_IP for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object PrefixOrigin -in @('Dhcp','Manual') | Sort-Object InterfaceMetric | Select-Object -First 1 -ExpandProperty IPAddress"') do set "LAN_IP=%%i"
if not defined LAN_IP (echo [dev-lan] Could not detect a LAN IP. Pass it explicitly:  scripts\dev-lan.cmd 192.168.1.10 & exit /b 1)

rem --- Dependencies and dev server build ---
if not exist node_modules call npm ci
if errorlevel 1 exit /b 1
if not exist build\dev mkdir build\dev
"%GOEXE%" build -o build\dev\piik-server.exe ./cmd/piik-server
if errorlevel 1 exit /b 1

echo.
echo [dev-lan] Host opens:       http://localhost:8787
echo [dev-lan] Invite link base: http://%LAN_IP%:8787
echo.

rem --- Start the two windows; skip whichever port is already served ---
netstat -ano | findstr ":8787 " | findstr LISTENING >nul
if errorlevel 1 (start "Piik-Web-8787" /min cmd /k "npm run dev" & echo [dev-lan] Vite dev server starting on 8787) else (echo [dev-lan] Port 8787 already served, reuse it)
netstat -ano | findstr ":8788 " | findstr LISTENING >nul
rem   ALLOWED_ORIGINS replaces the default allowlist once set, so it must
rem   repeat the LAN origin alongside the host's localhost origin.
if errorlevel 1 (start "Piik-Server-8788" /min cmd /k "set PORT=8788&set PUBLIC_BASE_URL=http://%LAN_IP%:8787&set ALLOWED_ORIGINS=http://%LAN_IP%:8787,http://localhost:8787&build\dev\piik-server.exe" & echo [dev-lan] piik-server starting on 8788) else (echo [dev-lan] Port 8788 already served, reuse it - restart manually if LAN-IP changed)

endlocal
