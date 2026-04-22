---
name: project
description: yeet.md Obsidian plugin. Loads when working on this repo.
---

# yeet.md Obsidian plugin

Companion plugin for the [yeet.md](https://yeet.md) service. Publishes the active Markdown note to `https://yeet.md/s/<id>` via HTTP, persists the server-issued delete token so the user retains ownership for later unpublish.

## Architecture

Module boundaries:

- `src/main.ts` — plugin lifecycle. `onload` registers commands, wires vault + workspace events, mounts the status bar (desktop only, `Platform.isMobile` guard), opens the settings tab. All feature logic delegates to the other modules.
- `src/settings.ts` — `YeetPluginSettings` interface, `DEFAULT_SETTINGS`, and `YeetSettingTab` (a `PluginSettingTab`). Also exports `PublishedNoteRecord`.
- `src/api.ts` — thin `requestUrl` wrappers for `POST /api/share` and `DELETE /api/delete/:id`. Uses Obsidian's `requestUrl` NOT global `fetch` (plugin-review rule `no-restricted-globals`).
- `src/content.ts` — `sha256Hex` (via `crypto.subtle`), `generateClientId` (via `crypto.randomUUID`), and `stripFrontmatter` (line-by-line YAML filter, not a full parser).
- `src/modals.ts` — `PublishConflictModal` (three-way prompt when content has drifted) and `ConfirmUnpublishModal`.

Data storage: `publishedNotes` map inside plugin `data.json`, keyed by vault-relative note path. Records follow note renames via `vault.on('rename')`.

## Key conventions

- **No `any`.** Cast unknowns through `unknown` first, then narrow. See `main.ts`'s access to `app.setting` for the pattern.
- **No default hotkeys.** `obsidianmd/commands/no-default-hotkeys` forbids them. Commands are registered without `hotkeys`; README tells users to bind Ctrl/Cmd+Shift+Y themselves.
- **Sentence case in UI strings.** `obsidianmd/ui/sentence-case` is strict. If a placeholder must show a literal value, rephrase it (e.g. `"Field names, comma-separated"` instead of `"cssclasses, internal-id"`).
- **Use `Setting(...).setHeading()` not manual `<h3>`.** `obsidianmd/settings-tab/no-manual-html-headings`.
- **Use `requestUrl` not `fetch`.** `no-restricted-globals`. Response shape differs: `.json` is a property, not a method; `.status` for HTTP status; pass `throw: false` to handle non-2xx manually.
- **Mobile guard for status bar.** `addStatusBarItem` isn't supported on mobile. Check `Platform.isMobile`.
- **Tabs for indent.** Template uses tabs. Lint enforces it.

## API contract (server lives at `C:/Users/david/Development/yeet.md`)

```
POST /api/share
  Headers: Content-Type: application/json, X-Client-Id: <uuid>
  Body: { content: string }
  → 200 { id, url, deleteToken }

DELETE /api/delete/:id
  Headers:
    Content-Type: application/json
    X-Client-Id: <uuid>
    Authorization: Bearer <deleteToken>
  Body: { token: <deleteToken> }
  → 200 on success, 404 if already gone (treat as success)
```

Body + Authorization both carry the token because the web client historically used body and newer endpoints expect Authorization. Either works server-side.

## Publish state machine

Centralized in `main.ts::publishFile`:

| Prior record? | Content hash match? | Action |
|---|---|---|
| no | — | `performPublish` (fresh) |
| yes | yes | `copyRecord` (no new snapshot) |
| yes | no | `PublishConflictModal` → `resolveConflict` |

Conflict choices: `"copy"` (do nothing), `"new"` (POST only, old snapshot stays), `"replace"` (DELETE old, then POST new into the same record slot).

## Security model

Token ownership == authority. The server generates `deleteToken` (nanoid or equivalent), stores a hash, constant-time compares on delete. The plugin:

1. Never generates tokens itself.
2. Stores tokens only in `data.json` (Obsidian plugin storage).
3. Sends over HTTPS; warns if `apiBaseUrl` is not HTTPS.
4. Does not write tokens into notes, clipboard, or console.

Sync caveat documented in README: `data.json` rides with the vault, so shared vaults = shared ownership.

## Build / lint

```
pnpm install           # first time
pnpm build             # tsc + esbuild
pnpm lint              # eslint + obsidianmd rules
pnpm dev               # watch-mode esbuild
```

Both `pnpm build` and `pnpm lint` must pass with zero errors before shipping. No `eslint-disable`, no `any`.

## Files to ship in releases

`main.js`, `manifest.json`, `styles.css` — produced by `pnpm build`.
