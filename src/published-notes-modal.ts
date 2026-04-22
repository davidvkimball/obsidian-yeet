import { App, Modal, Notice, Setting } from "obsidian";
import type YeetPlugin from "./main";
import { ConfirmUnpublishModal } from "./modals";
import { groupSnapshotsByPath } from "./settings";
import { knownTokenIds } from "./token-storage";

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

		const localTokens = knownTokenIds(this.app);

		for (const { path, items } of grouped) {
			const block = contentEl.createDiv({ cls: "yeet-note-block" });
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
										.then(() => this.render());
								}).open();
							});
					});
			}
		}
	}
}
