' Startet den Haus-Tasks-Server ohne Konsolenfenster und startet ihn nach einem Absturz neu.
' Ausgaben landen in data\server.log. Wird von der Aufgabenplanung beim Anmelden aufgerufen.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")

nodeExe = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then nodeExe = """C:\Program Files\nodejs\node.exe"""

Do
  ' Das Fenster bleibt unsichtbar (0); True wartet, bis der Server endet.
  sh.Run "cmd /c " & nodeExe & " server.js >> data\server.log 2>&1", 0, True
  WScript.Sleep 10000
Loop
