import { App, Modal, Notice, Setting } from "obsidian";
import type YeetPlugin from "./main";
import { ConfirmUnpublishModal } from "./modals";

/**
 * Lists every published note from this vault with Open, Copy, and
 * Delete actions. Invoked from the "Show all published notes" command
 * so users have a modal-level view matching the UX of the browser
 * extension and the web app.
 */
export class PublishedNotesModal extends Modal {
	constructor(app: App, private readonly plugin: YeetPlugin) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Published notes" });

		const entries = Object.entries(this.plugin.settings.publishedNotes);
		if (entries.length === 0) {
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: "Nothing published from this vault yet.",
			});
			return;
		}

		for (const [path, record] of entries) {
			new Setting(contentEl)
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
								void this.plugin.unpublishByPath(path).then(() => this.render());
							}).open();
						})
				);
		}
	}
}
