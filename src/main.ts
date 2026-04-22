import {
	MarkdownView,
	Notice,
	Platform,
	Plugin,
	TAbstractFile,
	TFile,
} from "obsidian";
import { deleteShare, postShare, YeetApiError } from "./api";
import { generateClientId, sha256Hex, stripProperties } from "./content";
import {
	ConfirmUnpublishModal,
	PublishConflictChoice,
	PublishConflictModal,
} from "./modals";
import {
	DEFAULT_SETTINGS,
	PublishedNoteRecord,
	YeetPluginSettings,
	YeetSettingTab,
} from "./settings";

const STATUS_PUBLISHED = "yeet.md \u2713";
const STATUS_OUT_OF_DATE = "yeet.md \u2191";

export default class YeetPlugin extends Plugin {
	settings!: YeetPluginSettings;
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Per-vault client id, generated once and reused. Not a secret,
		// not an auth token; just a stable handle for server-side
		// rate-limit buckets.
		if (!this.settings.clientId) {
			this.settings.clientId = generateClientId();
			await this.saveSettings();
		}

		this.registerCommands();
		this.registerVaultEvents();

		// Status bar indicator: skip on mobile (addStatusBarItem is a
		// desktop-only API, and the status bar isn't visible there
		// anyway).
		if (!Platform.isMobile) {
			this.statusBarEl = this.addStatusBarItem();
			this.statusBarEl.addClass("yeet-status");
			this.statusBarEl.addEventListener("click", () => {
				void this.handleStatusClick();
			});
		}

		this.registerEvent(
			this.app.workspace.on("file-open", () => void this.refreshStatusBar())
		);
		this.registerEvent(
			this.app.workspace.on("editor-change", () => void this.refreshStatusBar())
		);

		this.addSettingTab(new YeetSettingTab(this.app, this));
		void this.refreshStatusBar();
	}

	onunload(): void {
		// this.register* handles all teardown. No manual cleanup needed.
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<YeetPluginSettings>
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// ---------- commands ----------

	private registerCommands(): void {
		// No default hotkey: Obsidian plugin guidelines discourage them
		// (high conflict risk with user bindings). README tells users to
		// bind Ctrl/Cmd+Shift+Y via Settings → Hotkeys.
		this.addCommand({
			id: "publish-current-note",
			name: "Publish current note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void this.publishFile(file);
				return true;
			},
		});

		this.addCommand({
			id: "copy-published-link",
			name: "Copy published link for current note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const record = this.settings.publishedNotes[file.path];
				if (!record) return false;
				if (!checking) void this.copyRecord(record);
				return true;
			},
		});

		this.addCommand({
			id: "unpublish-current-note",
			name: "Unpublish current note",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				const record = this.settings.publishedNotes[file.path];
				if (!record) return false;
				if (!checking) this.promptUnpublish(file.path, record);
				return true;
			},
		});

		this.addCommand({
			id: "open-published-notes-settings",
			name: "Show all published notes from this vault",
			callback: () => {
				// Opens the settings tab where the full list + per-note
				// Copy/Unpublish actions live. Avoids duplicating that UI
				// in a modal.
				const setting = (this.app as unknown as {
					setting: { open(): void; openTabById(id: string): void };
				}).setting;
				setting.open();
				setting.openTabById(this.manifest.id);
			},
		});
	}

	// ---------- publish flow ----------

	private async publishFile(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		const hash = await sha256Hex(content);
		const existing = this.settings.publishedNotes[file.path];

		// Already published, content unchanged → just copy the link.
		if (existing && existing.contentHash === hash) {
			await this.copyRecord(existing);
			return;
		}

		// Already published, content changed → ask how to resolve.
		if (existing && existing.contentHash !== hash) {
			new PublishConflictModal(this.app, existing.url, (choice) => {
				void this.resolveConflict(file, content, hash, existing, choice);
			}).open();
			return;
		}

		// Fresh publish.
		await this.performPublish(file, content, hash);
	}

	private async resolveConflict(
		file: TFile,
		content: string,
		hash: string,
		existing: PublishedNoteRecord,
		choice: PublishConflictChoice
	): Promise<void> {
		if (choice === "copy") {
			await this.copyRecord(existing);
			return;
		}
		if (choice === "replace") {
			try {
				await deleteShare({
					baseUrl: this.settings.apiBaseUrl,
					clientId: this.settings.clientId,
					sharedId: existing.sharedId,
					deleteToken: existing.deleteToken,
				});
			} catch (err) {
				// Continue even on delete failure; the user asked to
				// replace. Leaving the old snapshot live is acceptable
				// and they can clean it up later via the settings tab.
				new Notice(
					`Could not delete old snapshot: ${err instanceof Error ? err.message : String(err)}`
				);
			}
			delete this.settings.publishedNotes[file.path];
			await this.saveSettings();
		}
		await this.performPublish(file, content, hash);
	}

	private async performPublish(
		file: TFile,
		content: string,
		hash: string
	): Promise<void> {
		const toPublish = stripProperties(content, this.settings.stripProperties);
		try {
			const result = await postShare({
				baseUrl: this.settings.apiBaseUrl,
				clientId: this.settings.clientId,
				content: toPublish,
			});
			const record: PublishedNoteRecord = {
				sharedId: result.id,
				deleteToken: result.deleteToken,
				url: result.url,
				publishedAt: Date.now(),
				contentHash: hash,
			};
			this.settings.publishedNotes[file.path] = record;
			await this.saveSettings();

			if (this.settings.copyUrlOnPublish) {
				await navigator.clipboard.writeText(result.url);
			}
			if (this.settings.showToast) {
				new Notice(`Published: ${result.url}`);
			}
			void this.refreshStatusBar();
		} catch (err) {
			const msg = err instanceof YeetApiError ? err.message : String(err);
			new Notice(`Publish failed: ${msg}`);
		}
	}

	// ---------- unpublish ----------

	private promptUnpublish(path: string, record: PublishedNoteRecord): void {
		new ConfirmUnpublishModal(this.app, path, record.url, () => {
			void this.unpublishByPath(path);
		}).open();
	}

	async unpublishByPath(path: string): Promise<void> {
		const record = this.settings.publishedNotes[path];
		if (!record) return;
		try {
			await deleteShare({
				baseUrl: this.settings.apiBaseUrl,
				clientId: this.settings.clientId,
				sharedId: record.sharedId,
				deleteToken: record.deleteToken,
			});
			new Notice("Unpublished.");
		} catch (err) {
			const msg = err instanceof YeetApiError ? err.message : String(err);
			new Notice(`Unpublish failed: ${msg}`);
			return;
		}
		delete this.settings.publishedNotes[path];
		await this.saveSettings();
		void this.refreshStatusBar();
	}

	// ---------- rename tracking ----------

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (!(file instanceof TFile)) return;
				const record = this.settings.publishedNotes[oldPath];
				if (!record) return;
				delete this.settings.publishedNotes[oldPath];
				this.settings.publishedNotes[file.path] = record;
				void this.saveSettings();
			})
		);
	}

	// ---------- status bar ----------

	private async copyRecord(record: PublishedNoteRecord): Promise<void> {
		await navigator.clipboard.writeText(record.url);
		if (this.settings.showToast) {
			new Notice(`Link copied: ${record.url}`);
		}
	}

	private async handleStatusClick(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const record = this.settings.publishedNotes[file.path];
		if (!record) return;
		// If buffer diverges from published, route through the normal
		// publish flow so the user sees the conflict modal. Otherwise
		// just copy.
		await this.publishFile(file);
	}

	private async refreshStatusBar(): Promise<void> {
		if (!this.statusBarEl) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file ?? this.app.workspace.getActiveFile();
		if (!file) {
			this.statusBarEl.empty();
			return;
		}
		const record = this.settings.publishedNotes[file.path];
		if (!record) {
			this.statusBarEl.empty();
			return;
		}
		// Only hash what's on disk (cheap enough for typical notes).
		// Compare against the stored hash to decide "published" vs
		// "published but stale".
		try {
			const current = await this.app.vault.read(file);
			const currentHash = await sha256Hex(current);
			this.statusBarEl.empty();
			const span = this.statusBarEl.createEl("span", {
				text: currentHash === record.contentHash ? STATUS_PUBLISHED : STATUS_OUT_OF_DATE,
			});
			span.setAttr(
				"title",
				currentHash === record.contentHash
					? `Published at ${record.url}. Click to copy.`
					: `Changes not yet published. Click to publish.`
			);
			span.toggleClass("yeet-status-stale", currentHash !== record.contentHash);
		} catch {
			this.statusBarEl.empty();
		}
	}
}
