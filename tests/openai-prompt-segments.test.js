import { describe, expect, test } from '@jest/globals';

import {
    PROMPT_SEGMENTS,
    classifyChatCompletionMessage,
    getPromptSegment,
    tagPromptSegment,
} from '../public/scripts/openai-prompt-segments.js';

describe('classifyChatCompletionMessage', () => {
    test('chat history messages, their tool calls, and tool results are history', () => {
        expect(classifyChatCompletionMessage({ identifier: 'chatHistory-3', role: 'user' })).toBe(PROMPT_SEGMENTS.HISTORY);
        expect(classifyChatCompletionMessage({ identifier: 'toolCall-chatHistory-3', role: 'assistant' })).toBe(PROMPT_SEGMENTS.HISTORY);
        expect(classifyChatCompletionMessage({ identifier: 'call_abc', role: 'tool' })).toBe(PROMPT_SEGMENTS.HISTORY);
    });

    test('a depth injection is injected even though it sits among chat history', () => {
        expect(classifyChatCompletionMessage({ identifier: 'chatHistory-2', role: 'system', injected: true })).toBe(PROMPT_SEGMENTS.INJECTED);
    });

    test('everything else is prompt content', () => {
        expect(classifyChatCompletionMessage({ identifier: 'main', role: 'system' })).toBe(PROMPT_SEGMENTS.PROMPT);
        expect(classifyChatCompletionMessage({ identifier: 'newMainChat', role: 'system' })).toBe(PROMPT_SEGMENTS.PROMPT);
        expect(classifyChatCompletionMessage({ identifier: 'dialogueExamples 0-1', role: 'system' })).toBe(PROMPT_SEGMENTS.PROMPT);
        expect(classifyChatCompletionMessage({ role: 'assistant' })).toBe(PROMPT_SEGMENTS.PROMPT);
        expect(classifyChatCompletionMessage(undefined)).toBe(PROMPT_SEGMENTS.PROMPT);
    });
});

describe('tagPromptSegment / getPromptSegment', () => {
    test('the tag is readable but never serialized or spread into a copy', () => {
        const message = tagPromptSegment({ role: 'user', content: 'hi' }, PROMPT_SEGMENTS.HISTORY);

        expect(getPromptSegment(message)).toBe(PROMPT_SEGMENTS.HISTORY);
        expect(JSON.parse(JSON.stringify(message))).toEqual({ role: 'user', content: 'hi' });
        expect(Object.keys(message)).toEqual(['role', 'content']);
        expect(getPromptSegment({ ...message })).toBeNull();
    });

    test('untagged or unrecognized values read as null', () => {
        expect(getPromptSegment({ role: 'user', content: 'hi' })).toBeNull();
        expect(getPromptSegment({ promptSegment: 'bogus' })).toBeNull();
        expect(getPromptSegment(null)).toBeNull();
    });
});
