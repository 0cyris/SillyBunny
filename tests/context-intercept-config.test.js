import { describe, expect, test } from '@jest/globals';

import {
    appendOwnPresetAgentTurn,
    isInsertOutputOnlyIntercept,
    normalizeInterceptApplyMode,
    resolveContextInterceptPromptSource,
    resolveContextInterceptScope,
    selectContextInterceptInstruction,
    selectRecentChatMessages,
} from '../public/scripts/extensions/in-chat-agents/context-intercept-config.js';
import { tagPromptSegment } from '../public/scripts/openai-prompt-segments.js';

describe('normalizeInterceptApplyMode', () => {
    test('recognizes wrap and patch', () => {
        expect(normalizeInterceptApplyMode('wrap')).toBe('wrap');
        expect(normalizeInterceptApplyMode('patch')).toBe('patch');
    });

    test('falls back to replace for anything else, including an unrecognized future value', () => {
        expect(normalizeInterceptApplyMode('replace')).toBe('replace');
        expect(normalizeInterceptApplyMode('summarize')).toBe('replace');
        expect(normalizeInterceptApplyMode(undefined)).toBe('replace');
        expect(normalizeInterceptApplyMode(null)).toBe('replace');
        expect(normalizeInterceptApplyMode(42)).toBe('replace');
    });
});

describe('isInsertOutputOnlyIntercept', () => {
    test('is true only for wrap mode, the flag set, and pre-generation timing', () => {
        expect(isInsertOutputOnlyIntercept({ applyMode: 'wrap', insertOutputOnly: true }, 'pre-generation')).toBe(true);
    });

    test('ignores the flag entirely at post-main-generation timing', () => {
        expect(isInsertOutputOnlyIntercept({ applyMode: 'wrap', insertOutputOnly: true }, 'post-main-generation')).toBe(false);
    });

    test('is false for patch or replace mode even with the flag set', () => {
        expect(isInsertOutputOnlyIntercept({ applyMode: 'patch', insertOutputOnly: true }, 'pre-generation')).toBe(false);
        expect(isInsertOutputOnlyIntercept({ applyMode: 'replace', insertOutputOnly: true }, 'pre-generation')).toBe(false);
    });

    test('is false for wrap mode without the flag', () => {
        expect(isInsertOutputOnlyIntercept({ applyMode: 'wrap', insertOutputOnly: false }, 'pre-generation')).toBe(false);
        expect(isInsertOutputOnlyIntercept({ applyMode: 'wrap' }, 'pre-generation')).toBe(false);
    });

    test('tolerates a missing preProcess object', () => {
        expect(isInsertOutputOnlyIntercept(undefined, 'pre-generation')).toBe(false);
    });
});

describe('selectContextInterceptInstruction', () => {
    test('the pre-generation instruction is unchanged without the flag', () => {
        expect(selectContextInterceptInstruction({ timing: 'pre-generation', insertOutputOnly: false })).toBe(
            'You are modifying the complete outgoing context before the main model sees it. Return only the revised context content requested by the instructions above. Do not add commentary, labels, or code fences unless they are part of the context itself. If no changes are needed, return the original context content verbatim.',
        );
    });

    test('the post-main instruction is unchanged and ignores the flag', () => {
        const withoutFlag = selectContextInterceptInstruction({ timing: 'post-main-generation', insertOutputOnly: false });
        const withFlag = selectContextInterceptInstruction({ timing: 'post-main-generation', insertOutputOnly: true });

        expect(withoutFlag).toBe(
            'You are modifying the assistant response after the main model generated it, before it is shown or saved. Return only the final assistant response requested by the instructions above. Do not add commentary, labels, or code fences unless they are part of the response itself. If no changes are needed, return the original response verbatim.',
        );
        expect(withFlag).toBe(withoutFlag);
    });

    test('the insert-output-only instruction forbids the context, JSON, role labels, and a transcript', () => {
        const instruction = selectContextInterceptInstruction({ timing: 'pre-generation', insertOutputOnly: true });

        expect(instruction).not.toBe(selectContextInterceptInstruction({ timing: 'pre-generation', insertOutputOnly: false }));
        expect(instruction.toLowerCase()).toContain('only the text to insert');
        expect(instruction.toLowerCase()).toContain('json');
        expect(instruction.toLowerCase()).toContain('role labels');
        expect(instruction.toLowerCase()).toContain('transcript');
        expect(instruction.toLowerCase()).not.toContain('return the original context');
    });
});

describe('resolveContextInterceptScope', () => {
    test('replace mode always uses the full context regardless of the setting', () => {
        expect(resolveContextInterceptScope({ applyMode: 'replace', contextScope: 'recent', contextFormat: 'chat' })).toBe('full');
    });

    test('text-format prompts cannot be split by message and fall back to full', () => {
        expect(resolveContextInterceptScope({ applyMode: 'wrap', contextScope: 'recent', contextFormat: 'text' })).toBe('full');
    });

    test('wrap/patch in chat format honors an explicit "recent" setting', () => {
        expect(resolveContextInterceptScope({ applyMode: 'wrap', contextScope: 'recent', contextFormat: 'chat' })).toBe('recent');
        expect(resolveContextInterceptScope({ applyMode: 'patch', contextScope: 'recent', contextFormat: 'chat' })).toBe('recent');
    });

    test('defaults to full when the setting is missing or unrecognized', () => {
        expect(resolveContextInterceptScope({ applyMode: 'wrap', contextFormat: 'chat' })).toBe('full');
        expect(resolveContextInterceptScope({ applyMode: 'wrap', contextScope: 'bogus', contextFormat: 'chat' })).toBe('full');
    });
});

describe('selectRecentChatMessages', () => {
    const tagged = (message, segment) => tagPromptSegment(message, segment);
    const buildPrompt = () => [
        tagged({ role: 'system', content: 'main prompt' }, 'prompt'),
        tagged({ role: 'system', content: '<filesystem>index</filesystem>' }, 'prompt'),
        tagged({ role: 'user', content: 'h1' }, 'history'),
        tagged({ role: 'assistant', content: 'h2' }, 'history'),
        tagged({ role: 'system', content: '<game-data>sheet</game-data>' }, 'injected'),
        tagged({ role: 'user', content: 'h3' }, 'history'),
        tagged({ role: 'assistant', content: 'h4' }, 'history'),
        tagged({ role: 'system', content: 'jailbreak' }, 'prompt'),
    ];
    const contents = messages => messages.map(message => message.content);

    test('drops only older chat history, keeping prompts and injections in place', () => {
        expect(contents(selectRecentChatMessages(buildPrompt(), 2))).toEqual([
            'main prompt',
            '<filesystem>index</filesystem>',
            '<game-data>sheet</game-data>',
            'h3',
            'h4',
            'jailbreak',
        ]);
    });

    test('keeps the original message objects so their tags survive', () => {
        const prompt = buildPrompt();
        const selected = selectRecentChatMessages(prompt, 1);

        expect(selected[0]).toBe(prompt[0]);
        expect(selected).toContain(prompt[6]);
        expect(selected).not.toBe(prompt);
    });

    test('never counts injections or prompts toward N', () => {
        expect(contents(selectRecentChatMessages(buildPrompt(), 1))).toEqual([
            'main prompt',
            '<filesystem>index</filesystem>',
            '<game-data>sheet</game-data>',
            'h4',
            'jailbreak',
        ]);
    });

    test('does not start the kept history on an orphaned tool result', () => {
        const prompt = [
            tagged({ role: 'system', content: 'main prompt' }, 'prompt'),
            tagged({ role: 'assistant', content: undefined, tool_calls: [{ id: 'call-1' }] }, 'history'),
            tagged({ role: 'tool', content: 'result', tool_call_id: 'call-1' }, 'history'),
            tagged({ role: 'user', content: 'latest' }, 'history'),
        ];

        expect(selectRecentChatMessages(prompt, 2).map(message => message.role)).toEqual(['system', 'user']);
    });

    test('treats untagged messages as prompt content and keeps them all', () => {
        const messages = [{ role: 'user', content: '1' }, { role: 'assistant', content: '2' }, { role: 'user', content: '3' }];

        expect(selectRecentChatMessages(messages, 1)).toEqual(messages);
    });

    test('returns everything when N covers all chat history', () => {
        expect(contents(selectRecentChatMessages(buildPrompt(), 50))).toEqual(contents(buildPrompt()));
    });

    test('falls back to the full list for a non-positive or non-numeric count', () => {
        const all = contents(buildPrompt());
        expect(contents(selectRecentChatMessages(buildPrompt(), 0))).toEqual(all);
        expect(contents(selectRecentChatMessages(buildPrompt(), -3))).toEqual(all);
        expect(contents(selectRecentChatMessages(buildPrompt(), 'nope'))).toEqual(all);
        expect(contents(selectRecentChatMessages(buildPrompt(), undefined))).toEqual(all);
    });

    test('tolerates a non-array input', () => {
        expect(selectRecentChatMessages(null, 2)).toEqual([]);
        expect(selectRecentChatMessages(undefined, 2)).toEqual([]);
    });
});

describe('resolveContextInterceptPromptSource', () => {
    const insertOnly = { applyMode: 'wrap', insertOutputOnly: true, contextFormat: 'chat', timing: 'pre-generation' };

    test('uses own-preset only for an insert-output-only chat intercept that asks for it', () => {
        expect(resolveContextInterceptPromptSource({ ...insertOnly, promptSource: 'own-preset' })).toBe('own-preset');
    });

    test('defaults to context when the setting is missing or unrecognized', () => {
        expect(resolveContextInterceptPromptSource(insertOnly)).toBe('context');
        expect(resolveContextInterceptPromptSource({ ...insertOnly, promptSource: 'preset' })).toBe('context');
        expect(resolveContextInterceptPromptSource({ ...insertOnly, promptSource: 'main-prompt' })).toBe('context');
        expect(resolveContextInterceptPromptSource()).toBe('context');
    });

    test('falls back to context for modes that need the context as data', () => {
        expect(resolveContextInterceptPromptSource({ ...insertOnly, promptSource: 'own-preset', insertOutputOnly: false })).toBe('context');
        expect(resolveContextInterceptPromptSource({ ...insertOnly, promptSource: 'own-preset', applyMode: 'patch' })).toBe('context');
        expect(resolveContextInterceptPromptSource({ ...insertOnly, promptSource: 'own-preset', applyMode: 'replace' })).toBe('context');
    });

    test('falls back to context for text prompts and post-main timing', () => {
        expect(resolveContextInterceptPromptSource({ ...insertOnly, promptSource: 'own-preset', contextFormat: 'text' })).toBe('context');
        expect(resolveContextInterceptPromptSource({ ...insertOnly, promptSource: 'own-preset', timing: 'post-main-generation' })).toBe('context');
    });
});

describe('appendOwnPresetAgentTurn', () => {
    test('appends the agent prompt and instruction as the final user turn after the assembled preset messages', () => {
        const presetMessages = [
            { role: 'system', content: 'Use read(path) to look up game data.' },
            { role: 'user', content: 'How much damage does a lasgun do?' },
        ];

        const messages = appendOwnPresetAgentTurn({ presetMessages, agentPrompt: 'Look it up.', generationType: 'normal' });

        expect(messages.slice(0, 2)).toEqual(presetMessages);
        expect(messages).toHaveLength(3);
        expect(messages[2].role).toBe('user');
        expect(messages[2].content.startsWith('Look it up.\n\n')).toBe(true);
        expect(messages[2].content).toContain('Return only the text to insert');
        expect(messages[2].content.endsWith('Generation type: normal')).toBe(true);
    });

    test('copies messages so the assembled preset messages are never mutated', () => {
        const presetMessages = [tagPromptSegment({ role: 'system', content: 'prompt' }, 'prompt')];

        const [copied] = appendOwnPresetAgentTurn({ presetMessages, agentPrompt: 'x' });
        copied.content = 'changed';

        expect(presetMessages[0].content).toBe('prompt');
    });

    test('tolerates missing or malformed preset messages', () => {
        expect(appendOwnPresetAgentTurn({ presetMessages: [null, 'text'], agentPrompt: 'x' })).toHaveLength(1);
        expect(appendOwnPresetAgentTurn()).toHaveLength(1);
    });
});
