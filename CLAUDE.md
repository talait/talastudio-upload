# talastudio-upload

- Commit messages in English.
- Two parts: `app/` is the Windows app (Tauri 2: Rust in `app/src-tauri`, plain TypeScript UI in `app/src`); `server/` is the Cloudflare Worker on `upload.talastudio.net`.
- Data lives in the TalaStudio Supabase project, schema `filedrop`. Database changes go as migrations in `talait/talastudio-supabase` (`supabase/migrations`), never here. The Worker only calls `filedrop.*` functions through Hyperdrive `talastudio-db-app` (role `ts_app`).
- A PC is a device token made once at install (the person types the PC name; no login, no approval — owner decision 23 Nov 2026). Only its hash is stored. Revoke a PC with `filedrop.devices.revoked_at`.
- File bytes never pass through the Worker on the way up: the Worker opens a Google Drive resumable session in `TALASTUDIO ASSETS/_UPLOAD/<item>/` and the PC uploads to it directly. Same bytes (sha256) are never uploaded twice; revisions of an item become new versions. Never overwrite or delete files on Drive.
- Never expose: `UPDATER_SIGNING_KEY`, the device token, the Drive session URL (only to the PC that uploads), `GOOGLE_SA_KEY`, installers to unregistered callers.
- Notifications: one Windows toast per upload of someone else, updated in place (progress → selesai with Buka/Unduh, removed on failure). Owner decision 23 Nov 2026.
- Releases: bump the version in `app/package.json` AND `app/src-tauri/Cargo.toml`, push a tag `vX.Y.Z`. The workflow builds the NSIS installer, makes a GitHub Release, and sends it to the Worker with GitHub OIDC (no shared secret); the Worker signs it with secret `UPDATER_SIGNING_KEY` (minisign Ed25519, public key in `tauri.conf.json`). Never change the public key: installed apps would stop updating. Apps check every 6 hours and install when no upload is running.
- Pin dependency versions. Before pushing: `npm run typecheck` in `server/` and `app/`, `npx wrangler deploy --dry-run --outdir dist` in `server/`, `cargo check` in `app/src-tauri` (Linux needs webkit2gtk; the Windows-only toast code is checked by CI).
