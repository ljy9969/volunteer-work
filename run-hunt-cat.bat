@echo off
REM Cat volunteer hunt: targets 2026-06-20 (Saturday) 10:00, 2 people. Runs headless.
cd /d "D:\source\JEON2\volunteer-work"
if not exist logs mkdir logs
REM Prune today lines from hunt-cat.log before this cycle.
"C:\Program Files\nodejs\node.exe" scripts\prune-log.js logs\hunt-cat.log >> "logs\prune.log" 2>&1
set ANIMAL_TYPE=cat
set SPECIFIC_DATE=2026-06-20
set TARGET_PEOPLE=2
set CANCEL_HUNT=true
"C:\Program Files\nodejs\node.exe" index.js >> "logs\hunt-cat.log" 2>&1
