import { App, Notice, PluginSettingTab } from "obsidian";
import type YeetPlugin from "./main";
import { ConfirmUnpublishModal } from "./modals";
import { createSettingsGroup } from "./utils/settings-compat";

/**
 * A single snapshot record. Snapshots are immutable: once published,
 * `url` + `deleteToken` don't change. A single note can produce many
 * snapshots over its lifetime (publish, edit, publish again). Each
 * lives here keyed by `sharedId` until the user unpublishes it.
 */
export interface PublishedSnapshot {
	/** Snapshot id returned by POST /api/share (maps to /s/<sharedId>). */
	sharedId: string;
	/** Delete token issued by the server. Required for unpublishing. */
	deleteToken: string;
	/** Full URL to the snapshot (cached for quick copy). */
	url: string;
	/** Unix ms timestamp of when this snapshot was created. */
	publishedAt: number;
	/** SHA-256 of the content at publish time. Used to detect whether
	 *  the active buffer still matches this snapshot. */
	contentHash: string;
	/** Vault-relative path of the note this snapshot came from at the
	 *  time it was published. Kept in sync via rename events so the
	 *  "Show all published snapshots" list groups correctly. */
	sourcePath: string;
}

export interface YeetPluginSettings {
	/** Base URL of the yeet.md API. Lets self-hosters point at their own. */
	apiBaseUrl: string;
	/** Copy the returned snapshot URL to clipboard after publish. */
	copyUrlOnPublish: boolean;
	/** Open the returned snapshot URL in the default browser after publish. */
	openUrlOnPublish: boolean;
	/** Show a toast with the snapshot URL after publish / copy. */
	showToast: boolean;
	/** Comma-separated allowlist of property keys to strip BEFORE
	 *  publishing. Obsidian-internal fields, private notes, etc. The
	 *  original note content is never modified; only the copy sent to
	 *  the server. Keys starting with `_` are always stripped. */
	stripProperties: string;
	/** Per-vault random UUID generated on first load. Sent as
	 *  X-Client-Id so the server can rate-limit per install without
	 *  identifying the user. */
	clientId: string;
	/** Every snapshot the plugin knows about, keyed by sharedId. One
	 *  note can appear multiple times here if the user published it
	 *  more than once. */
	publishedSnapshots: Record<string, PublishedSnapshot>;
}

export const DEFAULT_SETTINGS: YeetPluginSettings = {
	apiBaseUrl: "https://yeet.md",
	copyUrlOnPublish: true,
	openUrlOnPublish: false,
	showToast: true,
	stripProperties: "cssclasses, internal-id",
	clientId: "",
	publishedSnapshots: {},
};

/**
 * Helpers for querying + mutating the snapshot store.
 */
export function snapshotsForPath(
	snapshots: Record<string, PublishedSnapshot>,
	path: string
): PublishedSnapshot[] {
	return Object.values(snapshots)
		.filter((s) => s.sourcePath === path)
		.sort((a, b) => b.publishedAt - a.publishedAt);
}

export function findMatchingSnapshot(
	snapshots: Record<string, PublishedSnapshot>,
	path: string,
	contentHash: string
): PublishedSnapshot | undefined {
	return snapshotsForPath(snapshots, path).find((s) => s.contentHash === contentHash);
}

/**
 * Group the whole store by source path so the settings tab and the
 * "Show all published snapshots" modal can display:
 *   note-a.md
 *     snapshot-x  [Open] [Copy] [Delete]
 *     snapshot-y  [Open] [Copy] [Delete]
 *   note-b.md
 *     snapshot-z  ...
 */
export function groupSnapshotsByPath(
	snapshots: Record<string, PublishedSnapshot>
): Array<{ path: string; items: PublishedSnapshot[] }> {
	const byPath = new Map<string, PublishedSnapshot[]>();
	for (const snap of Object.values(snapshots)) {
		const list = byPath.get(snap.sourcePath) ?? [];
		list.push(snap);
		byPath.set(snap.sourcePath, list);
	}
	return Array.from(byPath.entries())
		.map(([path, items]) => ({
			path,
			items: items.sort((a, b) => b.publishedAt - a.publishedAt),
		}))
		.sort((a, b) => a.path.localeCompare(b.path));
}

export class YeetSettingTab extends PluginSettingTab {
	plugin: YeetPlugin;

	constructor(app: App, plugin: YeetPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const core = createSettingsGroup(containerEl, undefined, this.plugin.manifest.id);

		core.addSetting((setting) => {
			setting
				.setName("API base URL")
				.setDesc("Where to send Publish requests. Leave as https://yeet.md unless you self-host.")
				.addText((text) =>
					text
						.setPlaceholder("https://yeet.md")
						.setValue(this.plugin.settings.apiBaseUrl)
						.onChange(async (value) => {
							this.plugin.settings.apiBaseUrl = value.trim() || DEFAULT_SETTINGS.apiBaseUrl;
							await this.plugin.saveSettings();
							if (!this.plugin.settings.apiBaseUrl.startsWith("https://")) {
								new Notice(
									"Warning: API base URL is not HTTPS. Delete tokens will travel unencrypted."
								);
							}
						})
				);
		});

		core.addSetting((setting) => {
			setting
				.setName("Copy link after publish")
				.setDesc("Automatically copy the snapshot URL to clipboard once a publish succeeds.")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.copyUrlOnPublish)
						.onChange(async (value) => {
							this.plugin.settings.copyUrlOnPublish = value;
							await this.plugin.saveSettings();
						})
				);
		});

		core.addSetting((setting) => {
			setting
				.setName("Open link after publish")
				.setDesc("Open the snapshot URL in your default browser once a publish succeeds.")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.openUrlOnPublish)
						.onChange(async (value) => {
							this.plugin.settings.openUrlOnPublish = value;
							await this.plugin.saveSettings();
						})
				);
		});

		core.addSetting((setting) => {
			setting
				.setName("Show toast on publish")
				.setDesc("Display a notice with the snapshot URL after a successful publish.")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.showToast)
						.onChange(async (value) => {
							this.plugin.settings.showToast = value;
							await this.plugin.saveSettings();
						})
				);
		});

		core.addSetting((setting) => {
			setting
				.setName("Strip property fields before publish")
				.setDesc(
					"Comma-separated property names to remove from the copy sent to yeet.md. Keys starting with an underscore are always stripped. Your note is not modified."
				)
				.addText((text) =>
					text
						.setPlaceholder("Field names, comma-separated")
						.setValue(this.plugin.settings.stripProperties)
						.onChange(async (value) => {
							this.plugin.settings.stripProperties = value;
							await this.plugin.saveSettings();
						})
				);
		});

		const grouped = groupSnapshotsByPath(this.plugin.settings.publishedSnapshots);
		const totalSnapshots = Object.keys(this.plugin.settings.publishedSnapshots).length;
		const snapshotsGroup = createSettingsGroup(
			containerEl,
			`Published snapshots (${totalSnapshots})`,
			this.plugin.manifest.id
		);

		if (grouped.length === 0) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "Nothing published from this vault yet. Every publish creates a new immutable snapshot; prior ones stay live at their own links until you delete them.",
			});
			return;
		}

		for (const { path, items } of grouped) {
			snapshotsGroup.addSetting((setting) => {
				setting.setName(path).setDesc(
					items.length === 1 ? "1 snapshot" : `${items.length} snapshots`
				);
			});
			for (const snap of items) {
				snapshotsGroup.addSetting((setting) => {
					const when = new Date(snap.publishedAt).toLocaleString();
					setting
						.setName(snap.url)
						.setDesc(`Published ${when}`)
						.addExtraButton((btn) =>
							btn
								.setIcon("external-link")
								.setTooltip("Open")
								.onClick(() => {
									window.open(snap.url, "_blank", "noopener");
								})
						)
						.addExtraButton((btn) =>
							btn
								.setIcon("copy")
								.setTooltip("Copy link")
								.onClick(async () => {
									await navigator.clipboard.writeText(snap.url);
									new Notice("Link copied");
								})
						)
						.addExtraButton((btn) =>
							btn
								.setIcon("trash")
								.setTooltip("Delete")
								.onClick(() => {
									new ConfirmUnpublishModal(this.app, path, snap.url, () => {
										void this.plugin
											.unpublishBySharedId(snap.sharedId)
											.then(() => this.display());
									}).open();
								})
						);
				});
			}
		}
	}
}
