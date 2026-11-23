# TalaStudio Upload

Windows app for the TalaStudio team: drop renders, drawings and models, they go to Google Drive
`TALASTUDIO ASSETS/_UPLOAD/<item>/`, and every PC sees the same history (who sent what, which version, who downloaded it).

## For the team

1. Install `TalaStudio Upload_x.y.z_x64-setup.exe` (first time Windows may say "Unknown publisher": More info → Run anyway).
2. Type the PC name once (for example "Rinto"). No login.
3. Send files: drag them onto the window, onto the taskbar button (hold a moment and the window opens), onto the desktop
   shortcut, or right-click a file → Send to → TalaStudio Upload. The item code in the file name (DH-104) is recognised;
   otherwise the app asks once.
4. Everyone else gets one Windows notification per upload: it shows the progress and turns into "selesai" with Buka / Unduh.

The app starts with Windows, lives in the tray (grey normal, orange uploading, green new files, red an upload failed),
and updates itself.

## How it works

```
PC app ──(device token)──> upload.talastudio.net (Worker) ──> Supabase schema filedrop (history, versions, downloads)
   │                                   └──> opens a Drive resumable session (service account)
   └──────────── file bytes ────────────────> Google Drive TALASTUDIO ASSETS/_UPLOAD/<item>/
```

- `server/` — Worker. Secret `GOOGLE_SA_KEY` set in the Cloudflare dashboard. Deployed by Workers Builds on push to main (root directory `server`).
- `app/` — Tauri 2 app. Built by `.github/workflows/build.yml` on Windows; tag `vX.Y.Z` to release.
- Database: migration `20261123100000_filedrop.sql` in `talait/talastudio-supabase`.

## Updates

Push a tag `vX.Y.Z` (after bumping the version in `app/package.json` and `app/src-tauri/Cargo.toml`). The build sends the
installer to the Worker with GitHub OIDC; the Worker signs it (secret `UPDATER_SIGNING_KEY`, Ed25519 in minisign format)
and offers it to every installed app. The public key is in `app/src-tauri/tauri.conf.json`; apps reject anything not
signed with the matching key, and the signature carries the version (`requireSignedVersion`).
