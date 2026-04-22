/**
 * Content helpers: hashing, property stripping, UUID generation.
 *
 * All browser-only APIs (crypto.subtle, crypto.getRandomValues); no
 * Node dependencies, mobile-compatible.
 */

/**
 * Hex SHA-256 of a string. Used to detect "buffer matches last
 * published version" without hitting the server.
 */
export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Generate a per-vault client id. Sent as X-Client-Id for rate
 * limiting. Not sensitive; does not authenticate anything.
 */
export function generateClientId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Parse the comma-separated strip list from settings into a normalized
 * lowercase Set. Keys starting with "_" are always stripped regardless
 * of whether they appear in the allowlist.
 */
function parseStripList(raw: string): Set<string> {
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter((s) => s.length > 0)
	);
}

/**
 * Strip Obsidian properties listed in `stripFields` (or starting with
 * "_") from the content that will be published. The original note is
 * never modified; this produces a new string for the HTTP body.
 *
 * Line-by-line parse covers common YAML: "key: value" and array
 * continuations ("  - item"). Does not attempt to handle every edge
 * case (nested maps, multiline strings with ---) because the goal is
 * "hide private properties" not "be a full YAML parser."
 */
export function stripProperties(content: string, stripFieldsCsv: string): string {
	if (!content.startsWith("---")) return content;
	const afterOpener = content.indexOf("\n");
	if (afterOpener === -1) return content;
	const rest = content.slice(afterOpener + 1);
	const closerIdx = rest.indexOf("\n---");
	if (closerIdx === -1) return content;

	const yamlBlock = rest.slice(0, closerIdx);
	const bodyStart = closerIdx + 4; // skip "\n---"
	const body = rest.slice(bodyStart).replace(/^\n/, "");

	const strip = parseStripList(stripFieldsCsv);
	const lines = yamlBlock.split("\n");
	const kept: string[] = [];
	let skipUntilNextKey = false;

	for (const line of lines) {
		// Array continuation lines ("  - item") belong to the previous key.
		if (/^\s+-\s+/.test(line) || /^\s+\w/.test(line)) {
			if (skipUntilNextKey) continue;
			kept.push(line);
			continue;
		}
		// Top-level "key: ..."; decide whether to keep.
		const keyMatch = line.match(/^(\w[\w-]*)\s*:/);
		if (keyMatch && keyMatch[1]) {
			const key = keyMatch[1].toLowerCase();
			skipUntilNextKey = key.startsWith("_") || strip.has(key);
			if (!skipUntilNextKey) kept.push(line);
			continue;
		}
		// Blank, comment, or other; keep when not in a skipped block.
		if (!skipUntilNextKey) kept.push(line);
	}

	// If nothing survives, drop the property block entirely so we
	// don't ship an empty "---\n---" sandwich.
	const trimmedKept = kept.join("\n").replace(/^\n+|\n+$/g, "");
	if (trimmedKept.length === 0) return body;

	return `---\n${trimmedKept}\n---\n\n${body}`;
}
