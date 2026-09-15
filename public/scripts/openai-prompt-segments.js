/**
 * Tags assembled chat-completion messages with the prompt segment they came
 * from, so CHAT_COMPLETION_PROMPT_READY listeners can tell real chat history
 * apart from preset prompts and in-chat depth injections without re-deriving
 * prompt assembly.
 *
 * The tag is a non-enumerable property: it never reaches the request payload,
 * and a listener that rebuilds a message object drops it, which leaves that
 * message untagged. Consumers must treat untagged messages as prompt content,
 * never as trimmable history.
 */

export const PROMPT_SEGMENT_PROPERTY = 'promptSegment';

export const PROMPT_SEGMENTS = Object.freeze({
    PROMPT: 'prompt',
    HISTORY: 'history',
    INJECTED: 'injected',
});

const KNOWN_PROMPT_SEGMENTS = new Set(Object.values(PROMPT_SEGMENTS));

/**
 * Classifies one assembled Message by the identifiers openai.js assigns while
 * populating chat history. Works on a flattened (squashed) collection too,
 * since it never relies on collection membership.
 * @param {{ identifier?: unknown, role?: unknown, injected?: unknown }} message
 * @returns {'prompt'|'history'|'injected'}
 */
export function classifyChatCompletionMessage(message) {
    if (message?.injected === true) {
        return PROMPT_SEGMENTS.INJECTED;
    }

    const identifier = String(message?.identifier ?? '');
    if (identifier.startsWith('chatHistory-') || identifier.startsWith('toolCall-') || message?.role === 'tool') {
        return PROMPT_SEGMENTS.HISTORY;
    }

    return PROMPT_SEGMENTS.PROMPT;
}

/**
 * @template {object} T
 * @param {T} chatMessage Plain chat-completion message about to be emitted.
 * @param {'prompt'|'history'|'injected'} segment
 * @returns {T}
 */
export function tagPromptSegment(chatMessage, segment) {
    Object.defineProperty(chatMessage, PROMPT_SEGMENT_PROPERTY, {
        value: segment,
        enumerable: false,
        configurable: true,
        writable: true,
    });
    return chatMessage;
}

/**
 * @param {unknown} chatMessage
 * @returns {'prompt'|'history'|'injected'|null} Null when the message carries no recognized tag.
 */
export function getPromptSegment(chatMessage) {
    const segment = chatMessage?.[PROMPT_SEGMENT_PROPERTY];
    return KNOWN_PROMPT_SEGMENTS.has(segment) ? segment : null;
}
