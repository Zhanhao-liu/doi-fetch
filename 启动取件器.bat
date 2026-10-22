@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Missing .venv in %~dp0
    echo Run these first:
    echo    uv venv .venv --python 3.12
    echo    uv pip install --python .venv\Scripts\python.exe -e ".[browser,webvpn]"
    pause
    exit /b 1
)
if exist ".venv\Scripts\pythonw.exe" (
    start "" ".venv\Scripts\pythonw.exe" -m doifetch.gui
) else (
    start "" ".venv\Scripts\python.exe" -m doifetch.gui
)
