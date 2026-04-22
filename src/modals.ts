import { App, Modal, Notice, Setting } from "obsidian";

/**
 * Pre-publish confirmation. Default-on the first time a user enables
 * the plugin so they get fair warning; toggleable off in settings for
 * anyone who doesn't want the prompt.
 */
export class ConfirmPublishModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly notePath: string,
		private readonly onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Publish to yeet.md?" });
		contentEl.createEl("p", {
			text: `This will publish the current contents of "${this.notePath}" to yeet.md. Anyone with the link can read it.`,
		});
		contentEl.createEl("p", {
			text: "You can delete the snapshot from inside this plugin later.",
		});
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Heads up: the delete token is stored in this plugin's data. If you reinstall the plugin without a backup, wipe the vault, or lose data.json some other way, the token goes with it and the snapshot can only be removed by reporting it to the site operator.",
		});

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText("Publish")
					.setCta()
					.onClick(() => {
						if (this.resolved) return;
						this.resolved = true;
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Result of the "this note was already published" prompt. */
export type PublishConflictChoice = "new" | "copy" | "replace";

/**
 * Shown when the user invokes Publish on a note that already has a
 * record with a DIFFERENT content hash than the buffer. Three paths:
 *   new:     POST again, old snapshot stays live, new /s/<id>
 *   copy:    Do nothing, copy existing URL
 *   replace: DELETE old snapshot, POST new one, store in same record
 */
export class PublishConflictModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly existingUrl: string,
		private readonly onChoice: (choice: PublishConflictChoice) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Already published" });
		contentEl.createEl("p", {
			text: "This note was previously published but its content has changed since. What would you like to do?",
		});
		const existing = contentEl.createEl("p", { cls: "setting-item-description" });
		existing.createEl("span", { text: "Current link: " });
		existing.createEl("a", {
			text: this.existingUrl,
			href: this.existingUrl,
			attr: { target: "_blank", rel: "noopener" },
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Copy existing link")
					.onClick(() => this.choose("copy"))
			)
			.addButton((btn) =>
				btn
					.setButtonText("Publish as new snapshot")
					.onClick(() => this.choose("new"))
			)
			.addButton((btn) =>
				btn
					.setButtonText("Replace (delete old, publish new)")
					.setWarning()
					.onClick(() => this.choose("replace"))
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private choose(choice: PublishConflictChoice): void {
		if (this.resolved) return;
		this.resolved = true;
		this.close();
		this.onChoice(choice);
	}
}

/** Confirmation gate for destructive unpublish. */
export class ConfirmUnpublishModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly notePath: string,
		private readonly url: string,
		private readonly onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Unpublish this note?" });
		contentEl.createEl("p", {
			text: `This will delete the public snapshot at ${this.url}. The link will stop working immediately. This cannot be undone.`,
		});
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `Note: ${this.notePath}`,
		});

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText("Unpublish")
					.setWarning()
					.onClick(() => {
						if (this.resolved) return;
						this.resolved = true;
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Helper shown by the "Show all published notes" command when the
 * vault has nothing published yet. Kept as a no-op modal so the user
 * still gets feedback.
 */
export function showEmptyPublishedNotice(): void {
	new Notice("No published notes in this vault yet.");
}
