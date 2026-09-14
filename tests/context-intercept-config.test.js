import { describe, expect, test } from '@jest/globals';

import {
    isInsertOutputOnlyIntercept,
    normalizeInterceptApplyMode,
    resolveContextInterceptScope,
    selectContextInterceptInstruction,
    selectRecentChatMessages,
} from '../public/scripts/extensions/in-chat-agents/context-intercept-config.js';

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
    const messages = [{ role: 'user', content: '1' }, { role: 'assistant', content: '2' }, { role: 'user', content: '3' }];

    test('returns the last N messages', () => {
        expect(selectRecentChatMessages(messages, 2)).toEqual(messages.slice(1));
    });

    test('returns everything when N is larger than the context', () => {
        expect(selectRecentChatMessages(messages, 50)).toEqual(messages);
    });

    test('falls back to the full list for a non-positive or non-numeric count', () => {
        expect(selectRecentChatMessages(messages, 0)).toEqual(messages);
        expect(selectRecentChatMessages(messages, -3)).toEqual(messages);
        expect(selectRecentChatMessages(messages, 'nope')).toEqual(messages);
        expect(selectRecentChatMessages(messages, undefined)).toEqual(messages);
    });

    test('tolerates a non-array input', () => {
        expect(selectRecentChatMessages(null, 2)).toEqual([]);
        expect(selectRecentChatMessages(undefined, 2)).toEqual([]);
    });
});
