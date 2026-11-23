; Extra shortcuts made by the installer:
;  - Desktop: drop files on it to send them (Windows passes the files to the app).
;  - "Kirim ke" (right-click a file > Send to > TalaStudio Upload).
!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\TalaStudio Upload.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  CreateShortCut "$SENDTO\TalaStudio Upload.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\TalaStudio Upload.lnk"
  Delete "$SENDTO\TalaStudio Upload.lnk"
!macroend
