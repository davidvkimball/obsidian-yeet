import { App, Notice, PluginSettingTab } from "obsidian";
import type YeetPlugin from "./main";
import { ConfirmUnpublishModal } from "./modals";
import { createSettingsGroup } from "./utils/settings-compat";

export interface PublishedNoteRecord {
	/** Snapshot id returned by POST /api/share (maps to /s/<sharedId>). */
	sharedId: string;
	/** Delete token issued by the server. Required for unpublishing. */
	deleteToken: string;
	/** Full URL to the snapshot (cached for quick copy). */
	url: string;
	/** Unix ms timestamp of the most recent publish. */
	publishedAt: number;
	/** SHA-256 of the published content so we can detect "buffer matches
	 *  published version" without round-tripping to the server. */
	contentHash: string;
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
	/** Map of vault-relative note path → published record. Rename tracker
	 *  in main.ts keeps this in sync when notes move. */
	publishedNotes: Record<string, PublishedNoteRecord>;
}

export const DEFAULT_SETTINGS: YeetPluginSettings = {
	apiBaseUrl: "https://yeet.md",
	copyUrlOnPublish: true,
	openUrlOnPublish: false,
	showToast: true,
	stripProperties: "cssclasses, internal-id",
	clientId: "",
	publishedNotes: {},
};

export class YeetSettingTab extends PluginSettingTab {
	plugin: YeetPlugin;

	constructor(app: App, plugin: YeetPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Core settings group: no heading so the first row sits flush
		// against the tab top, matching the convention of most Obsidian
		// plugins shipped since 1.11.0.
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

		// Published notes section: distinct heading + per-note actions.
		const published = Object.entries(this.plugin.settings.publishedNotes);
		const notesGroup = createSettingsGroup(
			containerEl,
			`Published notes (${published.length})`,
			this.plugin.manifest.id
		);

		if (published.length === 0) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "Nothing published from this vault yet.",
			});
			return;
		}

		for (const [path, record] of published) {
			notesGroup.addSetting((setting) => {
				setting
					.setName(path)
					.setDesc(record.url)
					.addExtraButton((btn) =>
						btn
							.setIcon("external-link")
							.setTooltip("Open")
							.onClick(() => {
								window.open(record.url, "_blank", "noopener");
							})
					)
					.addExtraButton((btn) =>
						btn
							.setIcon("copy")
							.setTooltip("Copy link")
							.onClick(async () => {
								await navigator.clipboard.writeText(record.url);
								new Notice("Link copied");
							})
					)
					.addExtraButton((btn) =>
						btn
							.setIcon("trash")
							.setTooltip("Delete")
							.onClick(() => {
								new ConfirmUnpublishModal(this.app, path, record.url, () => {
									void this.plugin.unpublishByPath(path).then(() => this.display());
								}).open();
							})
					);
			});
		}
	}
}
