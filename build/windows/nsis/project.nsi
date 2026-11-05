Unicode true

# Per-user installer (no admin rights): built by `wails build -nsis -installscope user`,
# which passes WAILS_INSTALL_SCOPE=user and REQUEST_EXECUTION_LEVEL=user. It installs to
# %LOCALAPPDATA%\Programs\TN5250 Terminal with HKCU uninstall keys and per-user shortcuts.
#
# Silent update (used by Check for Updates):  tn5250-terminal-setup-x64.exe /S /relaunch
# waits for the running app to close, installs over it and starts it again.
# Settings (%APPDATA%\tn5250-terminal) are never touched by install or uninstall.

!define PRODUCT_EXECUTABLE "tn5250-terminal.exe"
!define UNINST_KEY_NAME    "tn5250-terminal"

!include "wails_tools.nsh"

# Windows version resources need four parts: 0.1.2 -> 0.1.2.0, 0.1.2.1 stays.
!searchparse /noerrors "${INFO_PRODUCTVERSION}" "" VER_A "." VER_B "." VER_C "." VER_D
!ifdef VER_D
  !define VI_VERSION "${INFO_PRODUCTVERSION}"
!else
  !define VI_VERSION "${INFO_PRODUCTVERSION}.0"
!endif
VIProductVersion "${VI_VERSION}"
VIFileVersion    "${VI_VERSION}"

VIAddVersionKey "CompanyName"     "${INFO_COMPANYNAME}"
VIAddVersionKey "FileDescription" "${INFO_PRODUCTNAME} Setup"
VIAddVersionKey "ProductVersion"  "${INFO_PRODUCTVERSION}"
VIAddVersionKey "FileVersion"     "${INFO_PRODUCTVERSION}"
VIAddVersionKey "LegalCopyright"  "${INFO_COPYRIGHT}"
VIAddVersionKey "ProductName"     "${INFO_PRODUCTNAME}"

ManifestDPIAware true

!include "MUI.nsh"
!include "FileFunc.nsh"

!define MUI_ICON "..\icon.ico"
!define MUI_UNICON "..\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${PRODUCT_EXECUTABLE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${INFO_PRODUCTNAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Name "${INFO_PRODUCTNAME}"
OutFile "..\..\bin\tn5250-terminal-setup-x64.exe"
!if "${WAILS_INSTALL_SCOPE}" == "user"
  InstallDir "$LOCALAPPDATA\Programs\${INFO_PRODUCTNAME}"
!else
  !error "Build with -installscope user: this installer is per-user only."
!endif
ShowInstDetails show

Var Relaunch

Function .onInit
  !insertmacro wails.checkArchitecture
  StrCpy $Relaunch "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/relaunch" $R1
  ${IfNot} ${Errors}
    StrCpy $Relaunch "1"
  ${EndIf}
FunctionEnd

Section
  !insertmacro wails.setShellContext
  !insertmacro wails.webview2runtime

  SetOutPath $INSTDIR

  # A running app (an update it just started, or one left open) holds its exe:
  # retry for up to fifteen seconds, then stop with a clear message.
  StrCpy $R2 0
  SetOverwrite try
  retry:
    ClearErrors
    !insertmacro wails.files
    ${If} ${Errors}
      IntOp $R2 $R2 + 1
      ${If} $R2 < 15
        Sleep 1000
        Goto retry
      ${EndIf}
      SetErrorLevel 2
      IfSilent +2
        MessageBox MB_ICONSTOP "${INFO_PRODUCTNAME} is still running. Close it and run setup again."
      Abort
    ${EndIf}
  SetOverwrite on

  CreateShortcut "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
  ${IfNot} ${Silent}
    CreateShortcut "$DESKTOP\${INFO_PRODUCTNAME}.lnk" "$INSTDIR\${PRODUCT_EXECUTABLE}"
  ${EndIf}

  !insertmacro wails.writeUninstaller
SectionEnd

Function .onInstSuccess
  ${If} $Relaunch == "1"
    Exec '"$INSTDIR\${PRODUCT_EXECUTABLE}"'
  ${EndIf}
FunctionEnd

Section "uninstall"
  !insertmacro wails.setShellContext

  # WebView2 cache only; settings in %APPDATA%\tn5250-terminal stay.
  RMDir /r "$APPDATA\${PRODUCT_EXECUTABLE}"
  RMDir /r $INSTDIR

  Delete "$SMPROGRAMS\${INFO_PRODUCTNAME}.lnk"
  Delete "$DESKTOP\${INFO_PRODUCTNAME}.lnk"

  !insertmacro wails.deleteUninstaller
SectionEnd
