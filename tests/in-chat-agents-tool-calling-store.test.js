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
    test('new agents default to tool calling off', async () => {
        const store = await importStore();

        expect(store.createDefaultAgent().toolCalling).toEqual({ enabled: false });
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

        expect(normalized.toolCalling).toEqual({ enabled: false });
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

        expect(store.normalizeAgent({ toolCalling: { enabled: true } }).toolCalling).toEqual({ enabled: true });
        expect(store.normalizeAgent({ toolCalling: { enabled: 'true' } }).toolCalling).toEqual({ enabled: false });
        expect(store.normalizeAgent({ toolCalling: [true] }).toolCalling).toEqual({ enabled: false });
        expect(store.normalizeAgent({ toolCalling: null }).toolCalling).toEqual({ enabled: false });
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
        expect(exported?.toolCalling).toEqual({ enabled: true });
        expect(store.normalizeAgent(structuredClone(exported)).toolCalling).toEqual({ enabled: true });
    });
});
