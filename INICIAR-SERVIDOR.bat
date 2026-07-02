@echo off
title SINUCA PRO - Servidor
cd /d "%~dp0"
echo Iniciando o servidor da Sinuca Pro...
echo.
node server\server.js
echo.
echo O servidor parou. Se apareceu um erro acima, me mostre no Claude.
pause
