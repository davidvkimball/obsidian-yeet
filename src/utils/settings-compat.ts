/**
 * Compatibility helper for `SettingGroup`, introduced in Obsidian API
 * 1.11.0. Older builds fall through to a plain container with an
 * optional heading rendered via `Setting(...).setHeading()`.
 *
 * Usage:
 *   const group = createSettingsGroup(containerEl, "Published notes", "yeet");
 *   group.addSetting((s) => s.setName("...").addText(...));
 */
import { requireApiVersion, Setting, SettingGroup } from "obsidian";

export interface SettingsContainer {
	addSetting(cb: (setting: Setting) => void): void;
}

export function createSettingsGroup(
	containerEl: HTMLElement,
	heading?: string,
	manifestId?: string
): SettingsContainer {
	if (requireApiVersion("1.11.0") && typeof SettingGroup !== "undefined") {
		const group = heading
			? new SettingGroup(containerEl).setHeading(heading)
			: new SettingGroup(containerEl);
		return {
			addSetting(cb: (setting: Setting) => void) {
				group.addSetting(cb);
			},
		};
	}

	// Fallback for older Obsidian: manual heading + plain Setting() per row.
	if (manifestId) {
		containerEl.addClass(`${manifestId}-settings-compat`);
	}
	if (heading) {
		new Setting(containerEl).setName(heading).setHeading();
	}
	return {
		addSetting(cb: (setting: Setting) => void) {
			cb(new Setting(containerEl));
		},
	};
}
