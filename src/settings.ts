import { App, Notice, PluginSettingTab, Setting, SettingGroup } from "obsidian";
import type YeetPlugin from "./main";
import { ConfirmUnpublishModal } from "./modals";
import { knownTokenIds } from "./token-storage";

/**
 * A single snapshot record. Snapshots are immutable: once published,
 * `url` doesn't change. A single note can produce many snapshots over
 * its lifetime (publish, edit, publish again). Each lives here keyed
 * by `sharedId` until the user unpublishes it.
 *
 * NOTE: the server-issued delete token is NOT stored here. It lives
 * in Obsidian's SecretStorage so it can't leak through data.json
 * syncing to iCloud / git / Obsidian Sync. See src/token-storage.ts.
 * Consequence: unpublish requires being on the same device the
 * publish happened on.
 */
export interface PublishedSnapshot {
	/** Snapshot id returned by POST /api/share (maps to /s/<sharedId>). */
	sharedId: string;
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
	/** Show a confirmation modal before actually publishing. Default on
	 *  so first-time users see the privacy + data-loss disclaimer. */
	confirmOnPublish: boolean;
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
	confirmOnPublish: true,
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
	// Shown beside the plugin name in the settings sidebar on older Obsidian
	// versions (SettingTab.icon). Newer versions ignore it.
	public icon = 'lucide-share';
	plugin: YeetPlugin;

	constructor(app: App, plugin: YeetPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// 1.13.0+: framework calls this and skips display().
	// Pre-1.13.0: this method is not invoked; display() below runs as before.
	// See https://docs.obsidian.md/plugins/guides/migrate-declarative-settings
	getSettingDefinitions() {
		return [
			{
				type: "group" as const,
				items: [
					{
						name: "API base URL",
						desc: "Where to send Publish requests. Leave as https://yeet.md unless you self-host.",
						// Render: onChange has a side effect (HTTPS warning notice).
						render: (setting: Setting) => {
							setting.addText((text) =>
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
						},
					},
					{
						name: "Confirm on publish",
						desc: "Show a warning before each publish. Recommended on so you get a reminder that the content becomes public.",
						control: { type: "toggle" as const, key: "confirmOnPublish" },
					},
					{
						name: "Copy link after publish",
						desc: "Automatically copy the snapshot URL to clipboard once a publish succeeds.",
						control: { type: "toggle" as const, key: "copyUrlOnPublish" },
					},
					{
						name: "Open link after publish",
						desc: "Open the snapshot URL in your default browser once a publish succeeds.",
						control: { type: "toggle" as const, key: "openUrlOnPublish" },
					},
					{
						name: "Show toast on publish",
						desc: "Display a notice with the snapshot URL after a successful publish.",
						control: { type: "toggle" as const, key: "showToast" },
					},
					{
						name: "Strip property fields before publish",
						desc: "Comma-separated property names to remove from the copy sent to yeet.md. Keys starting with an underscore are always stripped. Your note is not modified.",
						control: {
							type: "text" as const,
							key: "stripProperties",
							placeholder: "Field names, comma-separated",
						},
					},
				],
			},
			{
				// The dynamic "Published snapshots" section. Its heading,
				// empty state, and per-note blocks all depend on the current
				// contents of publishedSnapshots, so the whole thing is built
				// inside a single render callback that mirrors display().
				render: (setting: Setting) => {
					// This definition only carries the dynamic section; the
					// stock setting row it's attached to is hidden so it can't
					// show as an empty row above the section.
					setting.settingEl.hide();
					const containerEl = setting.settingEl.parentElement;
					if (!containerEl) return;

					const grouped = groupSnapshotsByPath(this.plugin.settings.publishedSnapshots);
					const totalSnapshots = Object.keys(this.plugin.settings.publishedSnapshots).length;
					// SettingGroup renders the section heading with native 1.11+
					// styling (border + spacing). We only need the heading here; the
					// per-note blocks render as siblings below so the heading can't
					// wrap them into a tiny empty card.
					new SettingGroup(containerEl).setHeading(
						`Published snapshots (${totalSnapshots})`
					);

					if (grouped.length === 0) {
						containerEl.createEl("p", {
							cls: "setting-item-description",
							text: "Nothing published from this vault yet. Every publish creates a new immutable snapshot; prior ones stay live at their own links until you delete them.",
						});
						return;
					}

					const localTokens = knownTokenIds(this.app);

					for (const { path, items } of grouped) {
						// Each note gets its own bordered block. Header (note path +
						// snapshot count) at the top, snapshots listed newest-first
						// underneath. Block styling lives in styles.css.
						const block = containerEl.createDiv({ cls: "yeet-note-block" });
						const header = block.createDiv({ cls: "yeet-note-block-header" });
						header.createSpan({ cls: "yeet-note-block-title", text: path });
						header.createSpan({
							cls: "yeet-note-block-count",
							text: items.length === 1 ? "1 snapshot" : `${items.length} snapshots`,
						});

						for (const snap of items) {
							const when = new Date(snap.publishedAt).toLocaleString();
							const hasToken = localTokens.has(snap.sharedId);
							const descPieces = [`Published ${when}`];
							if (!hasToken) descPieces.push("Delete only from the device that published it");
							new Setting(block)
								.setName(snap.url)
								.setDesc(descPieces.join(" · "))
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
								.addExtraButton((btn) => {
									btn.setIcon("trash")
										.setTooltip(hasToken ? "Delete" : "Delete token lives on another device")
										.setDisabled(!hasToken)
										.onClick(() => {
											if (!hasToken) return;
											new ConfirmUnpublishModal(this.app, path, snap.url, () => {
												void this.plugin
													.unpublishBySharedId(snap.sharedId)
													.then(() => {
														// The set of snapshot rows changed, so rebuild
														// getSettingDefinitions. update() is 1.13+ only,
														// which is the only version that calls this method
														// in the first place; guard the cast for safety.
														(this as unknown as { update?: () => void }).update?.call(this);
													});
											}).open();
										});
								});
						}
					}
				},
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const core = new SettingGroup(containerEl);

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
				.setName("Confirm on publish")
				.setDesc("Show a warning before each publish. Recommended on so you get a reminder that the content becomes public.")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.confirmOnPublish)
						.onChange(async (value) => {
							this.plugin.settings.confirmOnPublish = value;
							await this.plugin.saveSettings();
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
		// SettingGroup renders the section heading with native 1.11+
		// styling (border + spacing). We only need the heading here; the
		// per-note blocks render as siblings below so the heading can't
		// wrap them into a tiny empty card.
		new SettingGroup(containerEl).setHeading(
			`Published snapshots (${totalSnapshots})`
		);

		if (grouped.length === 0) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "Nothing published from this vault yet. Every publish creates a new immutable snapshot; prior ones stay live at their own links until you delete them.",
			});
			return;
		}

		const localTokens = knownTokenIds(this.app);

		for (const { path, items } of grouped) {
			// Each note gets its own bordered block. Header (note path +
			// snapshot count) at the top, snapshots listed newest-first
			// underneath. Block styling lives in styles.css.
			const block = containerEl.createDiv({ cls: "yeet-note-block" });
			const header = block.createDiv({ cls: "yeet-note-block-header" });
			header.createSpan({ cls: "yeet-note-block-title", text: path });
			header.createSpan({
				cls: "yeet-note-block-count",
				text: items.length === 1 ? "1 snapshot" : `${items.length} snapshots`,
			});

			for (const snap of items) {
				const when = new Date(snap.publishedAt).toLocaleString();
				const hasToken = localTokens.has(snap.sharedId);
				const descPieces = [`Published ${when}`];
				if (!hasToken) descPieces.push("Delete only from the device that published it");
				new Setting(block)
					.setName(snap.url)
					.setDesc(descPieces.join(" · "))
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
					.addExtraButton((btn) => {
						btn.setIcon("trash")
							.setTooltip(hasToken ? "Delete" : "Delete token lives on another device")
							.setDisabled(!hasToken)
							.onClick(() => {
								if (!hasToken) return;
								new ConfirmUnpublishModal(this.app, path, snap.url, () => {
									void this.plugin
										.unpublishBySharedId(snap.sharedId)
										.then(() => this.display());
								}).open();
							});
					});
			}
		}
	}
}
