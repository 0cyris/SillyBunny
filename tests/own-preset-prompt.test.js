import { describe, expect, test } from '@jest/globals';

import {
    OWN_PRESET_DEFAULT_CHARACTER_ID,
    buildOwnPresetChatMessages,
    resolveOwnPresetOrderEntries,
} from '../public/scripts/extensions/in-chat-agents/own-preset-prompt.js';

function makePreset({ order, prompts, openai_max_context } = {}) {
    return {
        prompt_order: [{ character_id: Number(OWN_PRESET_DEFAULT_CHARACTER_ID), order: order ?? [] }],
        prompts: prompts ?? [],
        ...(openai_max_context !== undefined ? { openai_max_context } : {}),
    };
}

const BASIC_ORDER = [
    { identifier: 'main', enabled: true },
    { identifier: 'worldInfoBefore', enabled: true },
    { identifier: 'charDescription', enabled: true },
    { identifier: 'personaDescription', enabled: true },
    { identifier: 'chatHistory', enabled: true },
    { identifier: 'jailbreak', enabled: true },
];

const BASIC_PROMPTS = [
    { identifier: 'main', role: 'system', content: 'Write the next reply.' },
    { identifier: 'worldInfoBefore', marker: true },
    { identifier: 'charDescription', marker: true },
    { identifier: 'personaDescription', marker: true },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'jailbreak', role: 'system', content: 'Stay in character.' },
];

describe('resolveOwnPresetOrderEntries', () => {
    test('resolves the default (100001) character order', () => {
        const preset = makePreset({ order: BASIC_ORDER });
        expect(resolveOwnPresetOrderEntries(preset)).toBe(preset.prompt_order[0].order);
    });

    test('falls back to a single remaining order list without the dummy id', () => {
        const order = [{ identifier: 'main', enabled: true }];
        const preset = { prompt_order: [{ character_id: 5, order }], prompts: [] };
        expect(resolveOwnPresetOrderEntries(preset)).toBe(order);
    });

    test('returns null for a missing, empty, or multi-list-without-default prompt_order', () => {
        expect(resolveOwnPresetOrderEntries({})).toBeNull();
        expect(resolveOwnPresetOrderEntries({ prompt_order: [] })).toBeNull();
        expect(resolveOwnPresetOrderEntries({ prompt_order: [{ character_id: 100001, order: [] }] })).toBeNull();
        expect(resolveOwnPresetOrderEntries({
            prompt_order: [{ character_id: 5, order: [{ identifier: 'main', enabled: true }] }, { character_id: 6, order: [] }],
        })).toBeNull();
    });
});

describe('buildOwnPresetChatMessages', () => {
    test('fails visibly for a missing or malformed preset', () => {
        expect(buildOwnPresetChatMessages({ preset: null }).ok).toBe(false);
        expect(buildOwnPresetChatMessages({ preset: null }).reason).toBe('unresolvable-preset');
        expect(buildOwnPresetChatMessages({ preset: {} }).reason).toBe('unresolvable-preset');
    });

    test('fails visibly for a preset with no default prompt_order', () => {
        const preset = { prompt_order: [], prompts: [] };
        const result = buildOwnPresetChatMessages({ preset });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('no-prompt-order');
    });

    test('places character card fields, World Info, persona description, and chat history by prompt_order, not an assumed order', () => {
        const preset = makePreset({ order: BASIC_ORDER, prompts: BASIC_PROMPTS });

        const result = buildOwnPresetChatMessages({
            preset,
            charDescription: 'A brave knight.',
            personaDescription: 'The user is a wanderer.',
            worldInfoBeforeText: 'The kingdom is at war.',
            chatHistoryMessages: [
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' },
            ],
        });

        expect(result.ok).toBe(true);
        expect(result.messages).toEqual([
            { role: 'system', content: 'Write the next reply.' },
            { role: 'system', content: 'The kingdom is at war.' },
            { role: 'system', content: 'A brave knight.' },
            { role: 'system', content: 'The user is a wanderer.' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'system', content: 'Stay in character.' },
        ]);
    });

    test('respects a reordered prompt_order rather than a hardcoded sequence', () => {
        const reordered = [
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'main', enabled: true },
            { identifier: 'charDescription', enabled: true },
        ];
        const preset = makePreset({ order: reordered, prompts: BASIC_PROMPTS });

        const result = buildOwnPresetChatMessages({
            preset,
            charDescription: 'A brave knight.',
            chatHistoryMessages: [{ role: 'user', content: 'Hello' }],
        });

        expect(result.messages.map(m => m.content)).toEqual(['Hello', 'Write the next reply.', 'A brave knight.']);
    });

    test('skips disabled entries and identifiers missing from the preset catalog', () => {
        const order = [
            { identifier: 'main', enabled: false },
            { identifier: 'charDescription', enabled: true },
            { identifier: 'ghostIdentifier', enabled: true },
        ];
        const preset = makePreset({ order, prompts: BASIC_PROMPTS });

        const result = buildOwnPresetChatMessages({ preset, charDescription: 'Kept.' });

        expect(result.messages).toEqual([{ role: 'system', content: 'Kept.' }]);
    });

    test('omits empty markers and empty raw-content prompts without leaving gaps', () => {
        const preset = makePreset({ order: BASIC_ORDER, prompts: BASIC_PROMPTS });

        const result = buildOwnPresetChatMessages({ preset, charDescription: '', personaDescription: '   ' });

        expect(result.messages).toEqual([{ role: 'system', content: 'Write the next reply.' }, { role: 'system', content: 'Stay in character.' }]);
    });

    test('appends chat history at the end when chatHistory is absent from prompt_order rather than dropping it', () => {
        const order = [{ identifier: 'main', enabled: true }];
        const preset = makePreset({ order, prompts: BASIC_PROMPTS });

        const result = buildOwnPresetChatMessages({
            preset,
            chatHistoryMessages: [{ role: 'user', content: 'Still here?' }],
        });

        expect(result.messages).toEqual([
            { role: 'system', content: 'Write the next reply.' },
            { role: 'user', content: 'Still here?' },
        ]);
    });

    test('filters an entry by injection_trigger against the active generation type', () => {
        const order = [{ identifier: 'quietOnly', enabled: true }];
        const prompts = [{ identifier: 'quietOnly', role: 'system', content: 'Only during quiet.', injection_trigger: ['quiet'] }];
        const preset = makePreset({ order, prompts });

        expect(buildOwnPresetChatMessages({ preset, generationType: 'normal' }).messages).toEqual([]);
        expect(buildOwnPresetChatMessages({ preset, generationType: 'quiet' }).messages).toEqual([
            { role: 'system', content: 'Only during quiet.' },
        ]);
    });

    describe('extension prompts (BEFORE_PROMPT, IN_PROMPT, IN_CHAT)', () => {
        test('anchors a before-position entry at the very start', () => {
            const preset = makePreset({ order: [{ identifier: 'main', enabled: true }], prompts: BASIC_PROMPTS });

            const result = buildOwnPresetChatMessages({
                preset,
                extensionEntries: [{ position: 'before', role: 'system', content: 'Filesystem index.' }],
            });

            expect(result.messages[0]).toEqual({ role: 'system', content: 'Filesystem index.' });
        });

        test('anchors an in-prompt entry right before the chat-history block', () => {
            const preset = makePreset({ order: BASIC_ORDER, prompts: BASIC_PROMPTS });

            const result = buildOwnPresetChatMessages({
                preset,
                charDescription: 'Knight.',
                chatHistoryMessages: [{ role: 'user', content: 'Hi' }],
                extensionEntries: [{ position: 'in-prompt', role: 'system', content: 'End-of-prompt note.' }],
            });

            const contents = result.messages.map(m => m.content);
            expect(contents.indexOf('End-of-prompt note.')).toBe(contents.indexOf('Hi') - 1);
        });

        // The regression this module exists to fix: sillytavern-utils-lib's buildPrompt only
        // handled BEFORE_PROMPT/IN_PROMPT and silently dropped IN_CHAT depth entries like
        // Compendium's live game data (compendium_always, IN_CHAT depth 2).
        test('inserts an in-chat entry at messages.length - depth within the chat-history block', () => {
            const chatHistoryOnlyOrder = [{ identifier: 'chatHistory', enabled: true }];
            const chatHistoryOnlyPrompts = [{ identifier: 'chatHistory', marker: true }];
            const preset = makePreset({ order: chatHistoryOnlyOrder, prompts: chatHistoryOnlyPrompts });

            const result = buildOwnPresetChatMessages({
                preset,
                chatHistoryMessages: [
                    { role: 'user', content: 'turn1' },
                    { role: 'assistant', content: 'turn2' },
                    { role: 'user', content: 'turn3' },
                    { role: 'assistant', content: 'turn4' },
                ],
                extensionEntries: [{ position: 'in-chat', depth: 2, role: 'system', content: 'live game data' }],
            });

            expect(result.messages.map(m => m.content)).toEqual(['turn1', 'turn2', 'live game data', 'turn3', 'turn4']);
        });

        test('orders multiple in-chat depths deepest first without corrupting shallower insert points', () => {
            const chatHistoryOnlyOrder = [{ identifier: 'chatHistory', enabled: true }];
            const chatHistoryOnlyPrompts = [{ identifier: 'chatHistory', marker: true }];
            const preset = makePreset({ order: chatHistoryOnlyOrder, prompts: chatHistoryOnlyPrompts });

            const result = buildOwnPresetChatMessages({
                preset,
                chatHistoryMessages: [
                    { role: 'user', content: 'A' },
                    { role: 'user', content: 'B' },
                    { role: 'user', content: 'C' },
                    { role: 'user', content: 'D' },
                ],
                extensionEntries: [
                    { position: 'in-chat', depth: 0, role: 'system', content: 'depth0' },
                    { position: 'in-chat', depth: 1, role: 'system', content: 'depth1' },
                    { position: 'in-chat', depth: 2, role: 'system', content: 'depth2' },
                ],
            });

            expect(result.messages.map(m => m.content)).toEqual(['A', 'B', 'depth2', 'C', 'depth1', 'D', 'depth0']);
        });

        test('drops an extension entry with empty content', () => {
            const preset = makePreset({ order: [{ identifier: 'main', enabled: true }], prompts: BASIC_PROMPTS });

            const result = buildOwnPresetChatMessages({
                preset,
                extensionEntries: [{ position: 'before', role: 'system', content: '   ' }],
            });

            expect(result.messages).toEqual([{ role: 'system', content: 'Write the next reply.' }]);
        });
    });

    describe('token budget', () => {
        test('trims the oldest plain chat-history turns first to fit openai_max_context, keeping injected and preset content', () => {
            const preset = makePreset({
                order: BASIC_ORDER,
                prompts: BASIC_PROMPTS,
                openai_max_context: 40,
            });

            const result = buildOwnPresetChatMessages({
                preset,
                charDescription: 'Knight.',
                chatHistoryMessages: [
                    { role: 'user', content: 'a'.repeat(80) },
                    { role: 'user', content: 'b'.repeat(80) },
                    { role: 'user', content: 'recent turn' },
                ],
                extensionEntries: [{ position: 'in-chat', depth: 0, role: 'system', content: 'must stay' }],
                reservedTokens: 0,
            });

            const contents = result.messages.map(m => m.content);
            expect(contents).toContain('Write the next reply.');
            expect(contents).toContain('Knight.');
            expect(contents).toContain('must stay');
            expect(contents).toContain('recent turn');
            expect(contents).not.toContain('a'.repeat(80));
        });

        test('leaves messages untouched when openai_max_context is missing or not a positive number', () => {
            const preset = makePreset({ order: BASIC_ORDER, prompts: BASIC_PROMPTS });
            const history = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `turn ${i} ${'x'.repeat(50)}` }));

            const result = buildOwnPresetChatMessages({ preset, chatHistoryMessages: history });

            expect(result.messages.filter(m => m.content.startsWith('turn '))).toHaveLength(20);
        });
    });
});
