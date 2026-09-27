# Entfernt den automatischen Start wieder und beendet den laufenden Server.
# Ausführen:  powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
$taskName = 'Haus-Tasks Server'

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Aufgabe '$taskName' entfernt."
} else {
  Write-Host "Aufgabe '$taskName' war nicht eingerichtet."
}

# Der Server läuft als Kindprozess weiter, falls das Beenden der Aufgabe ihn nicht mitnimmt.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.js' -and $_.CommandLine -notmatch 'npm' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Server-Prozess $($_.ProcessId) beendet." }
