; ClaimHive Demo: Windows installer (Inno Setup 6). Built by desktop\build_windows.ps1.
; Installs for the current user only (no administrator rights needed). Synthetic data only.
#define AppName "ClaimHive Demo"
#ifndef AppVersion
  #define AppVersion "0.8.0"
#endif

[Setup]
AppId={{6C3E0F7A-2B4D-4F1E-9A55-3C1D8E7B2A90}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=ClaimHive Inc.
AppComments=Dental denial intelligence, demo edition with synthetic data only.
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputBaseFilename=ClaimHiveDemoSetup
Compression=lzma2/normal
SolidCompression=yes
LZMANumBlockThreads=4
WizardStyle=modern
SetupLogging=yes
UninstallDisplayName={#AppName}
InfoBeforeFile=before-install.txt

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist\stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\node\node.exe"; Parameters: """{app}\launcher.mjs"" start"; WorkingDir: "{app}"; Comment: "Start ClaimHive Demo and open it in your browser"
Name: "{group}\Stop ClaimHive Demo"; Filename: "{app}\node\node.exe"; Parameters: """{app}\launcher.mjs"" stop"; WorkingDir: "{app}"
Name: "{group}\ClaimHive demo sign-in details"; Filename: "{app}\node\node.exe"; Parameters: """{app}\launcher.mjs"" logins"; WorkingDir: "{app}"; Flags: runminimized
Name: "{group}\Reset ClaimHive demo data"; Filename: "{app}\node\node.exe"; Parameters: """{app}\launcher.mjs"" reset"; WorkingDir: "{app}"; Comment: "Delete the demo data; the next start builds a fresh demo"
Name: "{group}\Uninstall ClaimHive Demo"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\node\node.exe"; Parameters: """{app}\launcher.mjs"" start"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\node\node.exe"; Parameters: """{app}\launcher.mjs"" start"; WorkingDir: "{app}"; Description: "Start ClaimHive Demo now (the first start takes a few minutes)"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\node\node.exe"; Parameters: """{app}\launcher.mjs"" stop"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "StopDemo"

[Code]
// Upgrading: stop a running demo first so its files can be replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\launcher.mjs')) then
    Exec(ExpandConstant('{app}\node\node.exe'), '"' + ExpandConstant('{app}\launcher.mjs') + '" stop', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code);
end;

// Uninstalling: the demo data is synthetic, so it's removed by default (silent uninstalls too).
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var Data: String;
begin
  if CurUninstallStep = usPostUninstall then begin
    Data := ExpandConstant('{localappdata}\ClaimHive Demo');
    if DirExists(Data) then
      if SuppressibleMsgBox('Also delete the demo data (synthetic practices, claims and sign-ins)?', mbConfirmation, MB_YESNO, IDYES) = IDYES then
        DelTree(Data, True, True, True);
  end;
end;
