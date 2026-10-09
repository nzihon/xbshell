@echo off
cd /d "%~dp0"
echo Starting XTerminal...
start "" http://127.0.0.1:8080
node server.js
