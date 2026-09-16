/**
 * Pure prompt assembly for own-preset intercept requests: turns an agent's
 * connection-profile preset (its prompt_order and prompts, read via
 * getCompletionPresetByName — a read, not a preset switch) plus a set of
 * already-gathered ingredients into a chat-completion message array.
 *
 * Kept dependency-free so it can be unit tested without mocking chat state,
 * following this codebase's convention of factoring pure logic out of
 * agent-runner.js (see context-intercept-config.js and
 * agent-tool-call-loop.js). Callers do the impure gathering — character card
 * fields, World Info text, and extension prompts all need live chat/character
 * state — and hand the results in as plain data. No oai_settings access, no
 * selectPreset: the preset object is read-only input.
 *
 * Simplifications from upstream's own assembler (openai.js), each a
 * deliberate scope cut for a side-channel agent request, not the main
 * generation:
 * - Only the preset's default (character_id 100001) prompt_order is used;
 *   per-character prompt-order overrides are not resolved.
 * - injection_position/injection_depth overrides stored on individual
 *   preset prompts (Prompt Manager's "in-chat" per-prompt controls) are not
 *   applied; only the identifier's built-in marker meaning and its slot in
 *   prompt_order matter.
 * - BEFORE_PROMPT and IN_PROMPT extension prompts are anchored to the start
 *   and end of the assembled request rather than upstream's "relative to the
 *   main prompt" placement. IN_CHAT extension prompts (World Info depth
 *   entries and character depth prompts included) use the same
 *   messages.length - depth insert upstream uses, so the motivating case for
 *   this module — a depth-based injection like Compendium's live game data —
 *   is not dropped.
 * - dialogueExamples is rendered as the character's raw example-dialogue text
 *   rather than parsed into per-turn messages.
 * - worldInfoBeforeText/worldInfoAfterText are caller-supplied and, as of the
 *   current caller (agent-runner.js), always empty: assembly does not trigger
 *   its own World Info scan mid-generation (that would re-enter
 *   checkWorldInfo() a second time for the same turn, which nothing else in
 *   this codebase does). World Info depth entries still arrive generically
 *   through extensionEntries, already registered by the main generation's own
 *   scan this turn.
 * - Token budgeting is a character-count estimate, not the real tokenizer;
 *   only the plain chat-history turns are trimmed (oldest first) to fit.
 */

export const OWN_PRESET_DEFAULT_CHARACTER_ID = '100001';

export const OWN_PRESET_MARKER_IDENTIFIERS = Object.freeze({
    WORLD_INFO_BEFORE: 'worldInfoBefore',
    WORLD_INFO_AFTER: 'worldInfoAfter',
    CHAR_DESCRIPTION: 'charDescription',
    CHAR_PERSONALITY: 'charPersonality',
    SCENARIO: 'scenario',
    PERSONA_DESCRIPTION: 'personaDescription',
    DIALOGUE_EXAMPLES: 'dialogueExamples',
    CHAT_HISTORY: 'chatHistory',
});

const MARKER_IDENTIFIER_SET = new Set(Object.values(OWN_PRESET_MARKER_IDENTIFIERS));

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_RESERVED_TOKENS = 512;

function estimateTokens(text) {
    const length = typeof text === 'string' ? text.length : 0;
    return length === 0 ? 0 : Math.ceil(length / APPROX_CHARS_PER_TOKEN) + 4;
}

function normalizeRole(role) {
    return role === 'user' || role === 'assistant' ? role : 'system';
}

/**
 * Resolves the preset's default prompt_order entry list (character_id
 * 100001). Falls back to a single remaining order list when the preset only
 * has one, so hand-built fixtures without the dummy id still resolve.
 * @param {{ prompt_order?: unknown }} preset
 * @returns {{identifier: string, enabled?: boolean}[]|null}
 */
export function resolveOwnPresetOrderEntries(preset) {
    const orderLists = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
    const defaultList = orderLists.find(list => String(list?.character_id) === OWN_PRESET_DEFAULT_CHARACTER_ID);
    const order = Array.isArray(defaultList?.order)
        ? defaultList.order
        : (orderLists.length === 1 && Array.isArray(orderLists[0]?.order) ? orderLists[0].order : null);

    return Array.isArray(order) && order.length > 0 ? order : null;
}

/**
 * Splits already-resolved extension-prompt entries (World Info depth entries
 * included) into the three buckets own-preset assembly places them in.
 * @param {{ position?: 'before'|'in-prompt'|'in-chat', depth?: number, role?: string, content?: string }[]} entries
 */
function groupExtensionEntries(entries) {
    const before = [];
    const inPrompt = [];
    const depthBuckets = new Map();

    for (const entry of Array.isArray(entries) ? entries : []) {
        const content = typeof entry?.content === 'string' ? entry.content.trim() : '';
        if (!content) {
            continue;
        }

        const role = normalizeRole(entry.role);

        if (entry.position === 'in-chat') {
            const depth = Number.isFinite(Number(entry.depth)) ? Math.max(0, Math.floor(Number(entry.depth))) : 0;
            if (!depthBuckets.has(depth)) {
                depthBuckets.set(depth, { system: [], user: [], assistant: [] });
            }
            depthBuckets.get(depth)[role].push(content);
        } else if (entry.position === 'before') {
            before.push({ role, content });
        } else if (entry.position === 'in-prompt') {
            inPrompt.push({ role, content });
        }
    }

    return { before, inPrompt, depthBuckets };
}

/**
 * Collapses a list of {role, content} entries into at most one message per
 * role, in system/user/assistant order.
 * @param {{role: string, content: string}[]} entries
 */
function collapseByRole(entries) {
    const buckets = { system: [], user: [], assistant: [] };
    for (const { role, content } of entries) {
        buckets[normalizeRole(role)].push(content);
    }

    const messages = [];
    for (const role of ['system', 'user', 'assistant']) {
        if (buckets[role].length > 0) {
            messages.push({ role, content: buckets[role].join('\n') });
        }
    }
    return messages;
}

/**
 * Builds the chat-history block: the plain conversation turns with World
 * Info depth entries and other IN_CHAT extension prompts spliced in at
 * messages.length - depth, deepest depth first so each shallower insert's
 * target index still lands correctly against the growing array.
 * @param {{role?: string, content?: string}[]} historyMessages
 * @param {Map<number, {system: string[], user: string[], assistant: string[]}>} depthBuckets
 * @param {WeakSet<object>} trimmableSet Populated with the plain (non-injected) history message objects.
 */
function buildDepthInjectedHistory(historyMessages, depthBuckets, trimmableSet) {
    const messages = (Array.isArray(historyMessages) ? historyMessages : [])
        .filter(message => message && typeof message === 'object' && typeof message.content === 'string' && message.content.trim())
        .map(message => {
            const plain = { role: normalizeRole(message.role), content: message.content };
            trimmableSet.add(plain);
            return plain;
        });

    const depths = [...depthBuckets.keys()].sort((a, b) => b - a);
    for (const depth of depths) {
        const bucket = depthBuckets.get(depth);
        const roleMessages = [];
        for (const role of ['system', 'user', 'assistant']) {
            if (bucket[role].length > 0) {
                roleMessages.push({ role, content: bucket[role].join('\n') });
            }
        }
        if (roleMessages.length === 0) {
            continue;
        }
        const index = Math.max(0, messages.length - depth);
        messages.splice(index, 0, ...roleMessages);
    }

    return messages;
}

/**
 * Trims plain (non-injected) chat-history messages, oldest first, until the
 * assembled request fits the preset's context budget. Never trims preset
 * prompts, character card fields, World Info, or injected/depth content.
 * @param {object[]} messages
 * @param {WeakSet<object>} trimmableSet
 * @param {unknown} maxContext
 * @param {number} reservedTokens
 */
function applyOwnPresetBudget(messages, trimmableSet, maxContext, reservedTokens) {
    const parsedMaxContext = Number(maxContext);
    if (!Number.isFinite(parsedMaxContext) || parsedMaxContext <= 0) {
        return messages;
    }

    const budget = Math.max(1, parsedMaxContext - Math.max(0, Number(reservedTokens) || 0));
    const kept = [...messages];
    let total = kept.reduce((sum, message) => sum + estimateTokens(message.content), 0);

    while (total > budget) {
        const index = kept.findIndex(message => trimmableSet.has(message));
        if (index === -1) {
            break;
        }
        total -= estimateTokens(kept[index].content);
        kept.splice(index, 1);
    }

    return kept;
}

/**
 * Assembles an own-preset intercept request from an agent's connection-profile
 * preset and a set of already-gathered ingredients.
 * @param {object} options
 * @param {{prompt_order?: unknown, prompts?: unknown, openai_max_context?: unknown}} options.preset - From getCompletionPresetByName.
 * @param {string} [options.generationType]
 * @param {string} [options.charDescription]
 * @param {string} [options.charPersonality]
 * @param {string} [options.scenario]
 * @param {string} [options.personaDescription]
 * @param {string} [options.worldInfoBeforeText] - Raw World Info text, already selected by the caller.
 * @param {string} [options.worldInfoAfterText]
 * @param {string} [options.dialogueExamplesText] - Raw mes_example text.
 * @param {{role?: string, content?: string}[]} [options.chatHistoryMessages] - Chronological (oldest first).
 * @param {{position?: 'before'|'in-prompt'|'in-chat', depth?: number, role?: string, content?: string}[]} [options.extensionEntries]
 * @param {number} [options.reservedTokens]
 * @returns {{ok: boolean, reason: string|null, messages: {role: string, content: string}[]}}
 */
export function buildOwnPresetChatMessages({
    preset,
    generationType = 'normal',
    charDescription = '',
    charPersonality = '',
    scenario = '',
    personaDescription = '',
    worldInfoBeforeText = '',
    worldInfoAfterText = '',
    dialogueExamplesText = '',
    chatHistoryMessages = [],
    extensionEntries = [],
    reservedTokens = DEFAULT_RESERVED_TOKENS,
} = {}) {
    if (!preset || typeof preset !== 'object' || !Array.isArray(preset.prompts)) {
        return { ok: false, reason: 'unresolvable-preset', messages: [] };
    }

    const order = resolveOwnPresetOrderEntries(preset);
    if (!order) {
        return { ok: false, reason: 'no-prompt-order', messages: [] };
    }

    const markerText = {
        [OWN_PRESET_MARKER_IDENTIFIERS.WORLD_INFO_BEFORE]: worldInfoBeforeText,
        [OWN_PRESET_MARKER_IDENTIFIERS.WORLD_INFO_AFTER]: worldInfoAfterText,
        [OWN_PRESET_MARKER_IDENTIFIERS.CHAR_DESCRIPTION]: charDescription,
        [OWN_PRESET_MARKER_IDENTIFIERS.CHAR_PERSONALITY]: charPersonality,
        [OWN_PRESET_MARKER_IDENTIFIERS.SCENARIO]: scenario,
        [OWN_PRESET_MARKER_IDENTIFIERS.PERSONA_DESCRIPTION]: personaDescription,
        [OWN_PRESET_MARKER_IDENTIFIERS.DIALOGUE_EXAMPLES]: dialogueExamplesText,
    };

    const segments = [];
    let chatHistorySlotIndex = -1;

    for (const entry of order) {
        if (!entry?.enabled) {
            continue;
        }

        const identifier = String(entry.identifier ?? '');
        const promptDef = preset.prompts.find(candidate => candidate?.identifier === identifier);
        if (!promptDef) {
            continue;
        }

        if (Array.isArray(promptDef.injection_trigger) && promptDef.injection_trigger.length > 0
            && !promptDef.injection_trigger.includes(generationType)) {
            continue;
        }

        if (identifier === OWN_PRESET_MARKER_IDENTIFIERS.CHAT_HISTORY) {
            chatHistorySlotIndex = segments.length;
            segments.push([]);
            continue;
        }

        if (MARKER_IDENTIFIER_SET.has(identifier)) {
            const text = String(markerText[identifier] ?? '').trim();
            segments.push(text ? [{ role: 'system', content: text }] : []);
            continue;
        }

        const content = typeof promptDef.content === 'string' ? promptDef.content.trim() : '';
        segments.push(content ? [{ role: normalizeRole(promptDef.role), content }] : []);
    }

    const { before, inPrompt, depthBuckets } = groupExtensionEntries(extensionEntries);
    const trimmableSet = new WeakSet();
    const historyBlock = buildDepthInjectedHistory(chatHistoryMessages, depthBuckets, trimmableSet);

    if (chatHistorySlotIndex !== -1) {
        segments[chatHistorySlotIndex] = historyBlock;
    } else if (historyBlock.length > 0) {
        // No chatHistory marker in prompt_order (disabled or missing): append rather than drop the conversation.
        segments.push(historyBlock);
    }

    let messages = segments.flat();

    const inPromptMessages = collapseByRole(inPrompt);
    if (inPromptMessages.length > 0) {
        const insertAt = chatHistorySlotIndex !== -1
            ? segments.slice(0, chatHistorySlotIndex).reduce((sum, segment) => sum + segment.length, 0)
            : messages.length;
        messages.splice(insertAt, 0, ...inPromptMessages);
    }

    const beforeMessages = collapseByRole(before);
    messages = [...beforeMessages, ...messages];

    messages = applyOwnPresetBudget(messages, trimmableSet, preset.openai_max_context, reservedTokens);

    return { ok: true, reason: null, messages: messages.map(({ role, content }) => ({ role, content })) };
}
