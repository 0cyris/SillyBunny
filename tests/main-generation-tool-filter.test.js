import { describe, expect, test } from '@jest/globals';

import { excludeHiddenToolsFromMainGeneration } from '../public/scripts/extensions/in-chat-agents/main-generation-tool-filter.js';

const SEARCH_TOOL = { type: 'function', function: { name: 'search', description: 'Search', parameters: {} } };
const READ_TOOL = { type: 'function', function: { name: 'read', description: 'Read', parameters: {} } };
const WRITE_TOOL = { type: 'function', function: { name: 'write', description: 'Write', parameters: {} } };

describe('excludeHiddenToolsFromMainGeneration', () => {
    test('returns the same tools unmodified when nothing is hidden', () => {
        const tools = [SEARCH_TOOL, READ_TOOL];

        expect(excludeHiddenToolsFromMainGeneration(tools, [])).toBe(tools);
        expect(excludeHiddenToolsFromMainGeneration(tools, new Set())).toBe(tools);
        expect(excludeHiddenToolsFromMainGeneration(tools)).toBe(tools);
    });

    test('removes only the hidden tool by name', () => {
        const result = excludeHiddenToolsFromMainGeneration([SEARCH_TOOL, READ_TOOL, WRITE_TOOL], ['read']);

        expect(result).toEqual([SEARCH_TOOL, WRITE_TOOL]);
    });

    test('accepts a Set of hidden names directly', () => {
        const result = excludeHiddenToolsFromMainGeneration([SEARCH_TOOL, READ_TOOL], new Set(['search', 'read']));

        expect(result).toEqual([]);
    });

    test('hiding a name that is not registered leaves every tool untouched', () => {
        const tools = [SEARCH_TOOL, READ_TOOL];

        expect(excludeHiddenToolsFromMainGeneration(tools, ['nonexistent'])).toEqual(tools);
    });

    test('tolerates a non-array tools argument', () => {
        expect(excludeHiddenToolsFromMainGeneration(null, ['search'])).toBeNull();
        expect(excludeHiddenToolsFromMainGeneration(undefined, ['search'])).toBeUndefined();
        expect(excludeHiddenToolsFromMainGeneration([], ['search'])).toEqual([]);
    });
});
