# Richtet den automatischen Start des Haus-Tasks-Servers bei der Windows-Anmeldung ein.
# Ausführen:  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
$taskName = 'Haus-Tasks Server'
$vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
$root = Split-Path -Parent $PSScriptRoot

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Startet den Haus-Tasks-Server (Node.js) unsichtbar bei der Anmeldung' -Force | Out-Null

Write-Host "Aufgabe '$taskName' eingerichtet. Der Server startet ab der nächsten Anmeldung automatisch."
Write-Host "Jetzt sofort starten: Start-ScheduledTask -TaskName '$taskName'"
Write-Host "Protokoll: $(Join-Path $root 'data\server.log')"
