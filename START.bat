@echo off
title Stockkar Trader
cd /d "%~dp0"
echo Starting Stockkar Trader...
echo Open http://localhost:7777 in your browser
echo Keep this window open. Press CTRL+C to stop.
node server.js
pause
