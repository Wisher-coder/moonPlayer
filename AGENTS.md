# AGENTS.md

Authorized-testing (「站方授权测试专用」) video analysis/playback workspace. The current application is `MoontentRN/`; the root Tampermonkey userscript remains a separate tool.

## Repository map

- `MoontentRN/app/`: JavaScript Expo SDK 57 / React Native 0.86 / React 19 / NativeWind v4 client for iOS, Android and Web. Expo Router screens live in `src/app/`; shared code belongs in `src/components/`, `src/hooks/`, `src/lib/` and `src/theme/`. Read `app/AGENTS.md` before frontend edits and consult matching SDK documentation before changing Expo/native APIs.
- `MoontentRN/server/`: Node >=20, ESM Koa backend; `src/routes/` dispatches APIs, `src/plugins/` normalizes site data, and `src/plugins/cms/` handles dynamic resource sites. `src/plugins/telegram-tg/` (+ dedicated `routes/telegram.js` / `routes/telegram-extras.js` endpoints) is the account-based Telegram source — full chat, not read-only browsing — running on **teleproto** (pure-JS MTProto client, single client + `server/.telegram-session.json` session; TDLib was fully removed 2026-10). `tg-client.js` is the client base (downloadPool multi-connection media scheduler), `auth.js` login (phone/2FA/QR), `dialogs.js`/`messages.js`/`writes.js`/`updates.js`/`normalize.js` the 聊天域 (消息归一化/发送/交互/已读/事件环), `media.js` the video/image core (512KB chunk byte source), `extras.js` the 12 incremental capabilities, `engine.js` the facade/assembly. Offline domain tests live in `server/scripts/tg-tests/` (`node --test scripts/tg-tests`).
- `MoontentRN/desktop/`: Electron shell for the Expo Web client and embedded Koa backend. `MoontentRN/cli.js` is the shared run/build/install/deploy entry point.
- `Nodejs/`: standalone site adapters and diagnostic CLIs, not a separate npm package. `Nodejs/telegram.js` is the Telegram-link diagnostic CLI (own session, separate from the server plugin).
- **Never connect a second process to the server's Telegram session** (`.telegram-session.json` / `TELEGRAM_SESSION`): MTProto returns `AUTH_KEY_DUPLICATED` and permanently invalidates the session for everyone, including the running server — the account must then log in again (verified by incident 2026-10-15). Diagnose media issues via the server's own endpoints or the CLI's separate session only.
- `pnk3n_pentest_tool.user.js`: standalone userscript; its specific rules are below.
- `NextWeb/` (the predecessor Next.js webapp) has been removed from this repository. `MoontentRN/README.md` has deployment/platform details; where it and current code/package scripts disagree, prefer the code.

## Commands and verification

There is no root `package.json`. `app/`, `server/` and `desktop/` are independent npm packages with lockfiles; install with `npm ci` in the relevant directory. Commands below run from the repository root:

```bash
node MoontentRN/cli.js list                         # supported targets on this host
node MoontentRN/cli.js run web                      # backend + Expo Web development
npm --prefix MoontentRN/app run syntax-check        # Babel-check every src JS/JSX file
npm --prefix MoontentRN/app run lint
npm --prefix MoontentRN/app run export              # static Web output: app/dist/
node MoontentRN/server/scripts/check-plugins.mjs     # offline plugin-contract checks; see cache warning below
node MoontentRN/server/scripts/boot-check.mjs        # start server and check /api/sites
node MoontentRN/server/scripts/serve-check.mjs       # requires fresh app/dist/
node MoontentRN/server/scripts/smoke.mjs <site> --json
npm --prefix MoontentRN/desktop run selftest         # Electron production assembly; requires Web output
```

- No TypeScript configuration, typecheck script or unit-test runner is configured; `syntax-check` checks syntax, not types. React Compiler diagnostics are deliberately advisory warnings in `app/eslint.config.js`; do not rewrite player/ref patterns just to silence them.
- **Back up an existing `server/.cms-sources.json` before `check-plugins.mjs`: it overwrites and then deletes that cache.** This check is offline; `boot-check`, `serve-check`, desktop selftest and smoke can trigger upstream discovery/prewarming. Run network checks only against authorized sites.
- Focus smoke on changed site IDs. `smoke.mjs all --json` tolerates up to two failed main sites and excludes CMS failures from its exit-code gate; inspect the per-site results, not just exit 0.
- CLI `build web` outputs `MoontentRN/dist/web/`, unlike app `export` (`app/dist/`). Desktop prefers `dist/web/` over `app/dist/` when unpackaged; avoid validating stale output.
- `desktop/verify-menu.mjs` requires Electron CDP on 9222 and may navigate to a real upstream video.
- Treat `.env` and `MoontentRN/deploy.config.json` as sensitive — both are gitignored; the deploy config holds the deployment server's SSH credentials and must never be committed or published. Deployment commands publish remotely and are not routine validation.

## Frontend conventions

- Keep Chinese UI text/comments consistent with nearby code. Use relative imports and Expo Router; keep utilities out of the route directory. Native and `.web.js` implementations must expose compatible interfaces; do not leak DOM/browser APIs into native code or static-export evaluation.
- `app/app.config.js` is the Expo configuration source of truth, not `app.json`. Native directories are generated/ignored; change config/plugins and regenerate rather than hand-editing generated iOS/Android files. Preserve current HTTP permissions and iPad fullscreen settings required for API access/orientation locking.
- Follow the existing YouTube-like light/dark UI and responsive breakpoints: phone <768, tablet 768–1279, desktop >=1280. Player controls use white active states; red is reserved for errors there.
- Use semantic theme tokens. Keep `src/theme/tokens.js`, `src/global.css` and `src/lib/theme-context.jsx` synchronized; preserve Tailwind `darkMode: 'class'`.
- Use `src/lib/abs-fill.js`'s `ABS_FILL` for full overlays, not `StyleSheet.absoluteFillObject` (removed in RN 0.86) or spread `StyleSheet.absoluteFill` (not cross-platform).
- Add/change Solar icons in `app/icons.config.mjs`, then run `npm --prefix MoontentRN/app run gen:icons`. `src/components/icons.js` is generated; do not hand-edit it or add a runtime icon library.

## Backend rules

- `server/src/plugins/base.js` defines the `SitePlugin` contract (`list`/`search`/`detail`/`resolvePlay`, capability flags); the error contract is HTTP 502 with `{__err:1,message}` and `GET /api/{site}/{method}` returns normalized data. `server/src/lib/api-cache.js` provides shared caching — check it before adding per-plugin caches. Keep the plugin contract aligned across changes; new sites also need registry registration.
- Upstream entry domains rotate. Plugins ship publish-page/gateway-fallback discovery; per-site env overrides live in `server/.env` (table in `MoontentRN/README.md`「环境变量」). Failing sites are usually upstream changes — run the matching `Nodejs/<site>.js` diagnostic CLI to find the current address before assuming a code bug.
- `Nodejs/*.js` adapters are standalone implementations copied into server plugins, not imported by them. Treat them as provenance/diagnostic CLIs; port fixes to both copies or note the divergence.
- CMS (`zy_*`) sites are dynamic: source list is pulled on a timer with health probes and an offline fallback snapshot (`plugins/cms/fallback-sources.json`); the disk cache is `server/.cms-sources.json` (gitignored).

## Desktop rules

- `desktop/main.js` embeds the Koa backend (`createApp`) and serves the Expo Web export from a single localhost port (default 3001, with probe/reuse and `?api=` fallback — see README「Electron 桌面架构」). Web dist resolution prefers packaged resources, then `MoontentRN/dist/web`, then `MoontentRN/app/dist`.
- Renderer↔main IPC is restricted to the allowlisted `preload.cjs` bridge; do not enable `nodeIntegration`/loosen `contextIsolation`, and route new native capabilities through the same bridge.
- Player menu popups are separate always-on-top child windows (`moontent:menu-*`); menu actions are funneled back through the main process to the owner window. Platform feature flags freeze at module load (platform-specific `.web.js`/native splits), so runtime platform checks must not be introduced in shared code.

## Standalone userscript: `pnk3n_pentest_tool.user.js`

These rules apply only to the userscript, not to MoontentRN or Nodejs:

- One source file, one IIFE, `'use strict'`; no userscript build/lint/test runner. Verify manually in Tampermonkey on an authorized target page and watch the tool's log panel.
- Internal section order:
  1. **Plugin core** — `SitePlugin` base class: lifecycle `early()` (document-start sniffers) → `boot()` (panel + auto-takeover on body ready) → `manual()` (「一键解析播放」fallback button). Match semantics: `hostMatch()` (known domains, explicit `@match`) wins; `pathMatch()` (unknown-mirror path fallback via `@include` regex) only fires when no other site's known domain matched, and each site re-verifies a page shell signature in boot before acting — keep this guard so same-path pages of other sites are untouched.
  2. **Common layer** — marked `[[PTK-COMMON:BEGIN]]` … `[[PTK-COMMON:END]]`: GM storage wrapper `gmk`, `mkLogger`, `waitFor`, CDN load matrix, shared Artplayer player kernel, `mountPanel`.
  3. **Site plugins** (one class each): `Pnk3nSite`, `Aido8Site`, `YsSite`, `AvjbSite`, `BfSite`, `DsdSite`.
  4. **Registry & startup** — `registerSite(new XxxSite())` calls; registration order = boot priority. Boot is deliberately early: 10ms polling for `<body>`, does **not** wait for DOMContentLoaded.

### Userscript conventions

- All comments, log messages, and UI strings are **Chinese**; keep that style.
- Log via each plugin's `this.log` (from `mkLogger`, feeds the collapsible panel) — never `console.log`.
- Every user-visible change must **bump `@version` and prepend a changelog entry to the giant `@description`** block — that block is the project's whole version history; write the new entry in the same dense Chinese style.
- Adding a site = write one `SitePlugin` subclass + one `registerSite` line + new `@match`/`@include` rules + shell-signature check (see comments in section 0).
- GM APIs in use: `GM_xmlhttpRequest`, `GM_setValue/GetValue`, `GM_getResourceText`, `@connect` whitelist (includes `*`), `@run-at document-start`. Player libs (Artplayer / hls.js / mpegts.js) ship via `@resource`; loading falls back @resource → CDN matrix → GM-channel eval → hls.js + native video — don't break the fallback chain.

### Userscript gotchas

- Player-takeover logic (esp. the bf site, sections ~6) encodes hard-won invariants — "parse new stream before tearing down old player", in-place re-plant instead of rebuild, suppression of non-takeover videos, pc-adapt coexistence. **Read the surrounding version-history comments before touching takeover/teardown code**; regressions here historically caused "player disappears / ghost audio / refresh loops".
- Retry ladders and cooldowns are intentionally slow/conservative to avoid request storms — don't tighten them for speed.
- Sites rotate entry domains constantly; unknown mirrors are handled by path fallback + shell signature, not by enumerating domains.
