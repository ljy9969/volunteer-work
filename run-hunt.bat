@echo off
REM Hunt schedule: triggers on weekday 09:00-17:30 every 30 min. Runs headless. Skips the 15th (Monthly day).
cd /d "D:\source\JEON2\volunteer-work"
if not exist logs mkdir logs
REM Prune today's lines from hunt.log before this cycle (keeps yesterday-and-earlier).
REM Redirect prune-log status to a SEPARATE file (logs\prune.log). Redirecting to hunt.log
REM would make cmd hold hunt.log open, causing EBUSY when prune-log truncates it.
"C:\Program Files\nodejs\node.exe" scripts\prune-log.js logs\hunt.log >> "logs\prune.log" 2>&1
set CANCEL_HUNT=true
"C:\Program Files\nodejs\node.exe" index.js >> "logs\hunt.log" 2>&1
