@echo off
REM Scheduled run: SCHEDULED=true disables attempt cap (runs until 11:30 cutoff).
cd /d "D:\source\JEON2\volunteer-work"
if not exist logs mkdir logs
REM Prune today's lines from scheduled.log before this run (keeps yesterday-and-earlier).
REM Redirect prune-log status to a SEPARATE file (logs\prune.log). Redirecting to scheduled.log
REM would make cmd hold scheduled.log open, causing EBUSY when prune-log truncates it.
"C:\Program Files\nodejs\node.exe" scripts\prune-log.js logs\scheduled.log >> "logs\prune.log" 2>&1
set SCHEDULED=true
"C:\Program Files\nodejs\node.exe" index.js >> "logs\scheduled.log" 2>&1
