/**
 * Pure apply-mode, instruction-selection, and context-scope logic for
 * pre-/post-generation context intercept agents. Kept dependency-free so it
 * can be unit tested without mocking the rest of the agent runner, following
 * this codebase's convention of factoring pure logic out of agent-runner.js
 * (see agent-tool-call-loop.js and tool-call-recurse-limit.js).
 */

const POST_MAIN_GENERATION_INTERCEPT_TIMING = 'post-main-generation';

const INSERT_OUTPUT_ONLY_INSTRUCTION = 'You are producing a short block of text to insert into the outgoing '
    + 'context before the main model sees it — not a copy of the context itself. Return only the text to '
    + 'insert (e.g. retrieved facts). Never return the outgoing context, a JSON array, role labels, or a '
    + 'transcript. If there is nothing to insert, return an empty response.';

/**
 * Normalizes a stored applyMode value: only 'wrap' and 'patch' are
 * recognized, everything else (including an unrecognized value from a
 * newer export) falls back to 'replace' so an unknown mode never silently
 * drops context.
 * @param {unknown} value
 * @returns {'replace'|'wrap'|'patch'}
 */
export function normalizeInterceptApplyMode(value) {
    return value === 'wrap' || value === 'patch' ? value : 'replace';
}

/**
 * Whether an agent's wrap output should be treated as insert-only text: no
 * echoed context, ever. Only meaningful for pre-generation wrap intercepts;
 * post-main-generation timing ignores the flag entirely.
 * @param {{ applyMode?: unknown, insertOutputOnly?: unknown }} [preProcess]
 * @param {string} [timing]
 * @returns {boolean}
 */
export function isInsertOutputOnlyIntercept(preProcess = {}, timing = '') {
    return timing !== POST_MAIN_GENERATION_INTERCEPT_TIMING
        && normalizeInterceptApplyMode(preProcess?.applyMode) === 'wrap'
        && preProcess?.insertOutputOnly === true;
}

/**
 * Selects the system-message instruction sentence appended after the
 * agent's own prompt for a context-intercept request. Byte-for-byte
 * identical to the pre-existing text unless insertOutputOnly is active.
 * @param {{ timing?: string, insertOutputOnly?: boolean }} [options]
 * @returns {string}
 */
export function selectContextInterceptInstruction({ timing = '', insertOutputOnly = false } = {}) {
    if (timing === POST_MAIN_GENERATION_INTERCEPT_TIMING) {
        return 'You are modifying the assistant response after the main model generated it, before it is shown or saved. Return only the final assistant response requested by the instructions above. Do not add commentary, labels, or code fences unless they are part of the response itself. If no changes are needed, return the original response verbatim.';
    }

    if (insertOutputOnly) {
        return INSERT_OUTPUT_ONLY_INSTRUCTION;
    }

    return 'You are modifying the complete outgoing context before the main model sees it. Return only the revised context content requested by the instructions above. Do not add commentary, labels, or code fences unless they are part of the context itself. If no changes are needed, return the original context content verbatim.';
}

/**
 * Resolves the *effective* context scope for one context-intercept run.
 * Replace mode always sees the full context (a trimmed input would silently
 * drop everything outside the scope once it replaces the outgoing context),
 * and text-format prompts cannot be split by message.
 * @param {{ applyMode?: unknown, contextScope?: unknown, contextFormat?: string }} [options]
 * @returns {'full'|'recent'}
 */
export function resolveContextInterceptScope({ applyMode, contextScope, contextFormat } = {}) {
    if (normalizeInterceptApplyMode(applyMode) === 'replace') {
        return 'full';
    }

    if (contextFormat !== 'chat') {
        return 'full';
    }

    return contextScope === 'recent' ? 'recent' : 'full';
}

/**
 * Selects the last N chat-format messages an intercept agent's own request
 * should see. Only meaningful when resolveContextInterceptScope returned
 * 'recent'; callers otherwise send the full message list.
 * @param {object[]} messages
 * @param {unknown} count
 * @returns {object[]}
 */
export function selectRecentChatMessages(messages, count) {
    if (!Array.isArray(messages)) {
        return [];
    }

    const recentCount = Number.isFinite(Number(count)) && Number(count) > 0
        ? Math.floor(Number(count))
        : messages.length;

    return messages.slice(-recentCount);
}
