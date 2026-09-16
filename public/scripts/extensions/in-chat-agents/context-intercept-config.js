/**
 * Pure apply-mode, instruction-selection, and context-scope logic for
 * pre-/post-generation context intercept agents. Kept dependency-free so it
 * can be unit tested without mocking the rest of the agent runner, following
 * this codebase's convention of factoring pure logic out of agent-runner.js
 * (see agent-tool-call-loop.js and tool-call-recurse-limit.js). The only
 * import is the equally pure prompt-segment tag reader.
 */

import { PROMPT_SEGMENTS, getPromptSegment } from '../../openai-prompt-segments.js';

const POST_MAIN_GENERATION_INTERCEPT_TIMING = 'post-main-generation';

const INSERT_OUTPUT_ONLY_INSTRUCTION = 'You are producing a short block of text to insert into the outgoing '
    + 'context before the main model sees it — not a copy of the context itself. Return only the text to '
    + 'insert (e.g. retrieved facts). Never return the outgoing context, a JSON array, role labels, or a '
    + 'transcript. If there is nothing to insert, return an empty response.';

export const OWN_PRESET_INSERT_OUTPUT_ONLY_INSTRUCTION = 'You are an in-chat agent step assembled from your own '
    + 'connection profile preset, not the main model. Everything before this message is your own preset\'s '
    + 'prompt, character card, World Info, and extension prompts: follow its instructions, tool guidance, and '
    + 'data to carry out the agent instructions in this message, but do not reply to or continue the '
    + 'conversation. Return only the text to insert into the main model\'s context (e.g. retrieved facts). '
    + 'Never return a transcript, a JSON array, or role labels. If there is nothing to insert, return an empty '
    + 'response.';

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
 * Trims chat history, and only chat history, down to the last N messages for
 * an intercept agent's own request. Preset prompts, the character card, World
 * Info, extension prompts, and in-chat depth injections are always kept in
 * place: only messages tagged as history by prompt assembly can be dropped,
 * and untagged messages (e.g. ones another listener rebuilt) count as prompt
 * content. The kept history never starts on an orphaned tool result.
 * Only meaningful when resolveContextInterceptScope returned 'recent'.
 * @param {object[]} messages
 * @param {unknown} count
 * @returns {object[]}
 */
export function selectRecentChatMessages(messages, count) {
    if (!Array.isArray(messages)) {
        return [];
    }

    const historyIndexes = [];
    messages.forEach((message, index) => {
        if (getPromptSegment(message) === PROMPT_SEGMENTS.HISTORY) {
            historyIndexes.push(index);
        }
    });

    const recentCount = Number.isFinite(Number(count)) && Number(count) > 0
        ? Math.floor(Number(count))
        : historyIndexes.length;

    if (historyIndexes.length <= recentCount) {
        return [...messages];
    }

    let firstKept = historyIndexes.length - recentCount;
    // A tool result can't lead the kept history without the assistant tool call that produced it.
    while (firstKept < historyIndexes.length && messages[historyIndexes[firstKept]]?.role === 'tool') {
        firstKept++;
    }

    const dropped = new Set(historyIndexes.slice(0, firstKept));
    return messages.filter((_, index) => !dropped.has(index));
}

/**
 * Resolves whether an intercept agent's own request is built from its own
 * connection-profile preset rather than from the agent prompt plus the
 * context as data. Only insert-output-only agents in chat format can use
 * own-preset assembly: every other apply mode needs the context as data to
 * rewrite or echo it.
 * @param {{ applyMode?: unknown, insertOutputOnly?: unknown, promptSource?: unknown, contextFormat?: string, timing?: string }} [options]
 * @returns {'context'|'own-preset'}
 */
export function resolveContextInterceptPromptSource({ applyMode, insertOutputOnly, promptSource, contextFormat, timing = '' } = {}) {
    if (promptSource !== 'own-preset' || contextFormat !== 'chat') {
        return 'context';
    }

    return isInsertOutputOnlyIntercept({ applyMode, insertOutputOnly }, timing) ? 'own-preset' : 'context';
}

/**
 * Appends the own-preset insert-output-only instruction and the agent prompt
 * as the final user turn onto an already-assembled own-preset request.
 * @param {{ presetMessages?: object[], agentPrompt?: string, generationType?: string }} [options]
 * @returns {object[]}
 */
export function appendOwnPresetAgentTurn({ presetMessages, agentPrompt = '', generationType = '' } = {}) {
    const promptMessages = (Array.isArray(presetMessages) ? presetMessages : [])
        .filter(message => message && typeof message === 'object')
        .map(message => ({ ...message }));

    return [
        ...promptMessages,
        {
            role: 'user',
            content: `${agentPrompt}\n\n${OWN_PRESET_INSERT_OUTPUT_ONLY_INSTRUCTION}\n\nGeneration type: ${generationType}`,
        },
    ];
}
