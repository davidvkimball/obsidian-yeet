# yeet.md for Obsidian

Publish the current note to [yeet.md](https://yeet.md) with one hotkey. Persists the per-snapshot delete token so you can unpublish later from inside Obsidian.

## Install

Not yet in the community plugin directory. For now:

1. Clone this repo into `<vault>/.obsidian/plugins/yeet/`.
2. Run `pnpm install && pnpm build` inside that folder.
3. Restart Obsidian. Enable **yeet.md** under **Settings → Community plugins**.

## Commands

All four appear in the command palette and can be bound under **Settings → Hotkeys**:

- **yeet.md: Publish current note**. Suggested hotkey: `Ctrl/Cmd+Shift+Y`.
- **yeet.md: Copy published link for current note**
- **yeet.md: Unpublish latest snapshot of current note**
- **yeet.md: Show all published snapshots from this vault**

## Publish flow

Hitting Publish on a note handles three cases automatically:

- **Fresh.** Posts the note to yeet.md, copies the returned URL, stores the delete token.
- **Already published, unchanged.** Just copies the existing URL. No new snapshot.
- **Already published, edited since.** Prompts with three options:
  - **Copy existing link** (do nothing)
  - **Publish as new snapshot** (old one stays live at the old URL)
  - **Replace** (delete old snapshot, publish new one, reuse the record)

A status-bar indicator on desktop shows `yeet.md ✓` when the active buffer matches an existing snapshot and `yeet.md ↑` when the buffer has drifted from the latest snapshot. If a note has more than one snapshot, the count appears in parentheses.

### Why "snapshots" and not "published notes"?

Each publish creates an **immutable snapshot** at a unique `/s/<id>` URL. Editing the source note does not update prior snapshots, and unpublishing one does not unpublish the others. The plugin stores every snapshot the vault has ever produced so you can find, copy, or delete each of them individually.

## Settings

- **API base URL.** Defaults to `https://yeet.md`. Change it if you self-host.
- **Copy link after publish.** Automatically copies the URL to clipboard.
- **Show toast on publish.** Displays a notice with the URL.
- **Strip properties before publish.** Comma-separated property names to remove from the copy sent to the server. Fields starting with `_` are always stripped. Your note is not modified; only the HTTP payload.
- **Published snapshots.** Browsable list at the bottom grouped by source note, with per-snapshot Open / Copy / Delete buttons.

## Properties support

yeet.md renders Obsidian properties (YAML at the top of a note) as a clean metadata card above the note body. `title`, `tags`, `aliases`, dates, URLs, wikilinks, and arbitrary arrays all get sensible rendering. See the [yeet.md about page](https://yeet.md/about) for examples.

Use **Strip properties** in settings to hide private keys like `_internal`, `cssclasses`, plugin metadata, etc.

## Security

Ownership of a published snapshot is established by a **delete token** issued by the server at publish time. Tokens are stored in this plugin's `data.json`. Only a client that holds the token can unpublish the corresponding snapshot.

Hardening in this plugin:

- Token held client-side only. Never written to the note itself, never copied to clipboard, never logged.
- Sent over HTTPS only (plugin warns if you configure a non-HTTPS API base URL).
- `DELETE /api/delete/:id` sends the token in `Authorization: Bearer <token>`. Server hashes and constant-time compares.
- A per-vault random UUID is sent as `X-Client-Id` for server-side rate limiting. Not an auth credential.

**Sync caveat:** `data.json` syncs with the vault through Obsidian Sync, iCloud, git, or any other vault-level sync. That means any device or collaborator with access to your vault gets ownership of your snapshots. Solo vault is fine. Shared vault means shared ownership. Do not share vaults that contain published tokens with anyone you don't trust to unpublish on your behalf.

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
