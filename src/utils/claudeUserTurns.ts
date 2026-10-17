/**
 * Shared "is this a real human turn?" logic for Claude Code / Claude Desktop session events.
 *
 * Claude writes several kinds of `{"type":"user"}` events into the same JSONL stream, and only
 * some of them represent a human actually typing something:
 *
 *   1. Real human turns      — `content` is a string, or text blocks, written by the user.
 *   2. Tool results          — `content` is `[{"type":"tool_result",...}]`, replayed by the harness.
 *   3. Synthetic turns       — `content` is a string, but the whole string is a machine-generated
 *                              wrapper the harness injects into the conversation, e.g.
 *                              `<system-reminder>…</system-reminder>` (worktree/context notices) or
 *                              `<task-notification>…</task-notification>` (background task finished).
 *
 * Kind 2 was always excluded. Kind 3 was not, which both inflated interaction counts and — because
 * `aggregateSessionFileIntoStats` / `buildRecentSessionItems` drop any session whose computed
 * `interactions === 0` — meant a session's visibility could hinge entirely on synthetic noise.
 *
 * A real human turn is frequently *prefixed* by a synthetic wrapper rather than consisting solely of
 * one (Claude Desktop prepends a `<system-reminder>` describing the git worktree to the first
 * prompt), so the wrappers are stripped and what remains decides the verdict. That keeps such turns
 * counted while dropping events that are nothing but a wrapper.
 */

/**
 * Harness-injected wrapper elements that carry no human-authored text.
 *
 * Matched non-greedily and paired via a backreference so a `<system-reminder>` block can't swallow
 * the human prompt that follows it. Unclosed/unknown tags are deliberately left alone: stripping
 * them would risk discarding real prompt text that merely happens to contain angle brackets.
 */
const SYNTHETIC_USER_WRAPPER = /<(system-reminder|task-notification|local-command-stdout|local-command-stderr|command-message|command-name|command-args|command-contents)>[\s\S]*?<\/\1>/g;

/**
 * Remove harness-injected wrapper blocks from a user message, returning the human-authored
 * remainder (trimmed). Returns an empty string when the message was entirely synthetic.
 */
export function stripSyntheticUserWrappers(text: string): string {
	if (!text) { return ''; }
	return text.replace(SYNTHETIC_USER_WRAPPER, '').trim();
}

/**
 * Extract the human-authored text of a Claude `user` event, or `null` when the event is not a
 * human turn at all (a tool result, an empty message, or purely synthetic wrapper content).
 *
 * Callers are expected to have already filtered on `type === 'user'`, `!isSidechain` and
 * `message.role === 'user'`; this decides only the content-shape question.
 */
export function extractHumanUserText(event: any): string | null {
	const content = event?.message?.content;

	if (typeof content === 'string') {
		const text = stripSyntheticUserWrappers(content);
		return text ? text : null;
	}

	if (!Array.isArray(content)) { return null; }
	// A tool_result block anywhere marks the whole event as harness-replayed output, even when
	// text blocks sit alongside it.
	if (content.some((c: any) => c?.type === 'tool_result')) { return null; }

	const text = stripSyntheticUserWrappers(
		content.filter((c: any) => c?.type === 'text').map((c: any) => c?.text || '').join('\n')
	);
	return text ? text : null;
}

/**
 * Whether a Claude `user` event represents a real human turn worth counting as an interaction.
 */
export function isHumanUserTurn(event: any): boolean {
	return extractHumanUserText(event) !== null;
}
