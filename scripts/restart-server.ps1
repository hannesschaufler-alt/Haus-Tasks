# Startet den Haus-Tasks-Server neu, z. B. nach einem Update.
# Ausführen (PowerShell, im Projektordner):  powershell -ExecutionPolicy Bypass -File scripts\restart-server.ps1
$taskName = 'Haus-Tasks Server'

if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
  Write-Host "Die Aufgabe '$taskName' ist nicht eingerichtet. Zuerst scripts\install-autostart.ps1 ausführen."
  exit 1
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
# Der Server-Prozess kann das Stoppen der Aufgabe überleben und würde den Port weiter belegen.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $taskName
Write-Host 'Server neu gestartet. Seite mit Strg+F5 neu laden.'
