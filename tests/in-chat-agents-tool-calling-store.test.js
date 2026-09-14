import { describe, test, expect, jest } from '@jest/globals';

async function importStore() {
    jest.resetModules();

    await jest.unstable_mockModule('../public/script.js', () => ({
        getRequestHeaders: jest.fn(() => ({})),
        saveSettingsDebounced: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
        extension_settings: {},
        getContext: jest.fn(() => ({ groupId: null })),
    }));

    await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
        regexFromString: jest.fn(value => new RegExp(String(value ?? ''))),
        uuidv4: jest.fn(() => 'test-uuid'),
    }));

    return await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
}

describe('in-chat agent tool calling setting', () => {
    test('new agents default to tool calling off with every registered tool selected', async () => {
        const store = await importStore();

        expect(store.createDefaultAgent().toolCalling).toEqual({ enabled: false, mode: 'all', selectedTools: [] });
    });

    test('agents saved before the setting existed load with tool calling off', async () => {
        const store = await importStore();
        const legacyAgent = {
            id: 'legacy-companion',
            name: 'Lookup',
            prompt: 'Summarize the scene.',
            category: 'companion',
            connectionProfile: 'profile-1',
        };

        const normalized = store.normalizeAgent(legacyAgent);

        expect(normalized.toolCalling).toEqual({ enabled: false, mode: 'all', selectedTools: [] });
        expect(normalized).toMatchObject({
            id: 'legacy-companion',
            name: 'Lookup',
            prompt: 'Summarize the scene.',
            category: 'companion',
            execution: 'companion',
            connectionProfile: 'profile-1',
        });
    });

    test('only an explicit boolean true enables tool calling', async () => {
        const store = await importStore();

        expect(store.normalizeAgent({ toolCalling: { enabled: true } }).toolCalling).toEqual({ enabled: true, mode: 'all', selectedTools: [] });
        expect(store.normalizeAgent({ toolCalling: { enabled: 'true' } }).toolCalling.enabled).toBe(false);
        expect(store.normalizeAgent({ toolCalling: [true] }).toolCalling.enabled).toBe(false);
        expect(store.normalizeAgent({ toolCalling: null }).toolCalling.enabled).toBe(false);
    });

    test('an enabled setting survives loading and export', async () => {
        const store = await importStore();

        store.loadAgents([{
            id: 'tool-companion',
            name: 'Tool Companion',
            prompt: 'Look things up.',
            category: 'companion',
            toolCalling: { enabled: true },
        }]);

        const exported = store.exportAgent('tool-companion');
        expect(exported?.toolCalling).toEqual({ enabled: true, mode: 'all', selectedTools: [] });
        expect(store.normalizeAgent(structuredClone(exported)).toolCalling).toEqual({ enabled: true, mode: 'all', selectedTools: [] });
    });

    test('only "selected" switches the mode away from the "all tools" default', async () => {
        const store = await importStore();

        expect(store.normalizeAgent({ toolCalling: { mode: 'selected' } }).toolCalling.mode).toBe('selected');
        expect(store.normalizeAgent({ toolCalling: { mode: 'bogus' } }).toolCalling.mode).toBe('all');
        expect(store.normalizeAgent({ toolCalling: { mode: undefined } }).toolCalling.mode).toBe('all');
    });

    test('an explicit tool selection is trimmed, deduplicated, and order-preserving', async () => {
        const store = await importStore();

        const normalized = store.normalizeAgent({
            toolCalling: {
                mode: 'selected',
                selectedTools: [' Pathfinder_Search ', 'Pathfinder_Search', 'Compendium_Lookup', '', null],
            },
        });

        expect(normalized.toolCalling.selectedTools).toEqual(['Pathfinder_Search', 'Compendium_Lookup']);
    });

    test('a non-array selectedTools value normalizes to an empty selection', async () => {
        const store = await importStore();

        expect(store.normalizeAgent({ toolCalling: { mode: 'selected', selectedTools: 'Pathfinder_Search' } }).toolCalling.selectedTools).toEqual([]);
        expect(store.normalizeAgent({ toolCalling: { mode: 'selected', selectedTools: null } }).toolCalling.selectedTools).toEqual([]);
    });

    test('an explicit tool selection survives loading and export', async () => {
        const store = await importStore();

        store.loadAgents([{
            id: 'scoped-companion',
            name: 'Scoped Companion',
            prompt: 'Look things up, but only with the compendium.',
            category: 'companion',
            toolCalling: { enabled: true, mode: 'selected', selectedTools: ['Compendium_Lookup'] },
        }]);

        const exported = store.exportAgent('scoped-companion');
        expect(exported?.toolCalling).toEqual({ enabled: true, mode: 'selected', selectedTools: ['Compendium_Lookup'] });
        expect(store.normalizeAgent(structuredClone(exported)).toolCalling).toEqual({ enabled: true, mode: 'selected', selectedTools: ['Compendium_Lookup'] });
    });
});
