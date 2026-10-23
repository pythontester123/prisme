@echo off
title Prisme
cd /d "%~dp0"
if not exist node_modules (
  echo Installation des composants, une seule fois...
  call npm install --no-audit --no-fund
)
node server.js
pause
