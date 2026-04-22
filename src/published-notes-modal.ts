import { App, Modal, Notice, Setting } from "obsidian";
import type YeetPlugin from "./main";
import { ConfirmUnpublishModal } from "./modals";
import { groupSnapshotsByPath } from "./settings";

/**
 * Lists every published snapshot from this vault, grouped by source
 * note so multi-publish histories are visible. Invoked from the "Show
 * all published snapshots" command; parallels the web app and
 * browser extension's list views.
 */
export class PublishedSnapshotsModal extends Modal {
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
		contentEl.createEl("h2", { text: "Published snapshots" });

		const grouped = groupSnapshotsByPath(this.plugin.settings.publishedSnapshots);
		if (grouped.length === 0) {
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: "Nothing published from this vault yet. Every publish creates a new immutable snapshot; prior ones stay live at their own links until you delete them.",
			});
			return;
		}

		for (const { path, items } of grouped) {
			new Setting(contentEl)
				.setName(path)
				.setDesc(items.length === 1 ? "1 snapshot" : `${items.length} snapshots`)
				.setHeading();
			for (const snap of items) {
				const when = new Date(snap.publishedAt).toLocaleString();
				new Setting(contentEl)
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
										.then(() => this.render());
								}).open();
							})
					);
			}
		}
	}
}
