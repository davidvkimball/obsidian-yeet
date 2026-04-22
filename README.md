# yeet.md for Obsidian

Publish the current note to [yeet.md](https://yeet.md) with one hotkey. Persists the per-snapshot delete token so you can unpublish later from inside Obsidian.

## Install

Not yet in the community plugin directory. For now:

1. Clone this repo into `<vault>/.obsidian/plugins/yeet-md/`.
2. Run `pnpm install && pnpm build` inside that folder.
3. Restart Obsidian. Enable **yeet.md** under **Settings → Community plugins**.

## Commands

All four appear in the command palette and can be bound under **Settings → Hotkeys**:

- **yeet.md: Publish current note** — suggested hotkey `Ctrl/Cmd+Shift+Y`
- **yeet.md: Copy published link for current note**
- **yeet.md: Unpublish current note**
- **yeet.md: Show all published notes from this vault**

## Publish flow

Hitting Publish on a note handles three cases automatically:

- **Fresh** — posts the note to yeet.md, copies the returned URL, stores the delete token.
- **Already published, unchanged** — just copies the existing URL. No new snapshot.
- **Already published, edited since** — prompts with three options:
  - **Copy existing link** (do nothing)
  - **Publish as new snapshot** (old one stays live at the old URL)
  - **Replace** (delete old snapshot, publish new one, reuse the record)

A status-bar indicator on desktop shows `yeet.md ✓` when the current note is published and `yeet.md ↑` when the buffer has drifted since the last publish.

## Settings

- **API base URL** — defaults to `https://yeet.md`. Change it if you self-host.
- **Copy link after publish** — automatically copies the URL to clipboard.
- **Show toast on publish** — displays a notice with the URL.
- **Strip frontmatter fields before publish** — comma-separated property names to remove from the copy sent to the server. Fields starting with `_` are always stripped. Your note is never modified — only the HTTP payload.
- **Published notes** — browsable list at the bottom with per-note Copy / Unpublish buttons.

## Frontmatter support

yeet.md renders Obsidian frontmatter (YAML properties) as a clean metadata card above the note body. `title`, `tags`, `aliases`, dates, URLs, wikilinks, and arbitrary arrays all get sensible rendering. See the [yeet.md about page](https://yeet.md/about) for examples.

Use **Strip frontmatter fields** in settings to hide private properties like `_internal` keys, `cssclasses`, plugin metadata, etc.

## Security

Ownership of a published snapshot is established by a **delete token** issued by the server at publish time. Tokens are stored in this plugin's `data.json`. Only a client that holds the token can unpublish the corresponding snapshot.

Hardening in this plugin:

- Token held client-side only. Never written to the note itself, never copied to clipboard, never logged.
- Sent over HTTPS only (plugin warns if you configure a non-HTTPS API base URL).
- `DELETE /api/delete/:id` sends the token in `Authorization: Bearer <token>`. Server hashes and constant-time compares.
- A per-vault random UUID is sent as `X-Client-Id` for server-side rate limiting. Not an auth credential.

**Sync caveat:** `data.json` syncs with the vault through Obsidian Sync, iCloud, git, or any other vault-level sync. That means any device or collaborator with access to your vault gets ownership of your snapshots. Solo vault = fine. Shared vault = shared ownership. Do not share vaults that contain published tokens with anyone you don't trust to unpublish on your behalf.

## Development

```bash
pnpm install
pnpm dev      # rebuild on save
pnpm build    # production bundle
pnpm lint     # eslint + obsidianmd rules
```

Template: [obsidian-sample-plugin-plus](https://github.com/davidvkimball/obsidian-sample-plugin-plus). See `AGENTS.md` and `.agent/skills/` for the development skills system.

## License

MIT © David V. Kimball
