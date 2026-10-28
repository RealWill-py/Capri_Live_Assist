color a
@echo off
setlocal
cd /d "%~dp0"
echo Iniciando o Capri em http://localhost:8000
echo Deixe esta janela aberta enquanto usa o avatar no OBS.
echo Pressione Ctrl+C para encerrar.
set "PYTHON=%~dp0..\work\voice-runtime\.venv\Scripts\python.exe"
if not exist "%PYTHON%" (
  echo Runtime de voz nao instalado. Confira a pasta work\voice-runtime.
  pause
  exit /b 1
)
"%PYTHON%" server.py
if errorlevel 1 (
  echo.
  echo O servidor nao iniciou. Confira se o Python esta instalado ou se a porta 8000 ja esta em uso.
  pause
)
