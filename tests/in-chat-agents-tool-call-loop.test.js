import { describe, expect, test } from '@jest/globals';

import {
    AGENT_TOOL_CALLING_SKIP_REASONS,
    filterAgentToolSelection,
    isAgentToolCallingEnabled,
    resolveAgentToolCallingPlan,
    runAgentToolCallLoop,
    summarizeAgentToolCallingPlan,
} from '../public/scripts/extensions/in-chat-agents/agent-tool-call-loop.js';

const SEARCH_TOOL = {
    type: 'function',
    function: {
        name: 'compendium_search',
        description: 'Search the compendium',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
};
const READ_TOOL = {
    type: 'function',
    function: {
        name: 'compendium_read',
        description: 'Read a compendium entry',
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
    },
};
const PATHFINDER_ROLL_TOOL = {
    type: 'function',
    function: {
        name: 'pathfinder_roll',
        description: 'Roll dice for a Pathfinder skill check',
        parameters: { type: 'object', properties: { skill: { type: 'string' } } },
    },
};

function textResponse(text) {
    return { text };
}

function toolCallResponse(...calls) {
    return { text: '', calls };
}

function invocation(id, name, parameters, result, extra = {}) {
    return { id, displayName: name, name, parameters: JSON.stringify(parameters), result, error: false, signature: null, reasoning: null, ...extra };
}

/**
 * Builds plain send/detect/invoke/getText fakes from scripted responses and invocation rounds.
 */
function createHarness({ responses, rounds = [] }) {
    const requests = [];
    const invokedResponses = [];
    const pendingResponses = [...responses];
    const pendingRounds = [...rounds];

    return {
        requests,
        invokedResponses,
        deps: {
            send: async (request) => {
                requests.push(structuredClone(request));
                if (!pendingResponses.length) {
                    throw new Error('Unexpected extra send');
                }
                return pendingResponses.shift();
            },
            hasToolCalls: response => Array.isArray(response.calls) && response.calls.length > 0,
            invokeTools: async (response) => {
                invokedResponses.push(response);
                if (!pendingRounds.length) {
                    throw new Error('Unexpected extra invoke');
                }
                return { invocations: [], errors: [], stealthCalls: [], ...pendingRounds.shift() };
            },
            getText: response => response.text,
        },
    };
}

const BASE_MESSAGES = [
    { role: 'system', content: 'You are a lookup agent.' },
    { role: 'user', content: 'Who is Inquisitor Vex?' },
];

describe('runAgentToolCallLoop', () => {
    test('returns the first response text when it carries no tool calls', async () => {
        const harness = createHarness({ responses: [textResponse('Vex is an Ordo Hereticus inquisitor.')] });

        const result = await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [SEARCH_TOOL],
            recurseLimit: 5,
            ...harness.deps,
        });

        expect(result.text).toBe('Vex is an Ordo Hereticus inquisitor.');
        expect(result.invocations).toEqual([]);
        expect(result.requestCount).toBe(1);
        expect(result.stopReason).toBe('final');
        expect(harness.invokedResponses).toHaveLength(0);
        expect(harness.requests).toEqual([
            { messages: BASE_MESSAGES, tools: [SEARCH_TOOL], tool_choice: 'auto' },
        ]);
    });

    test('attaches tool definitions in unmodified OpenAI function format', async () => {
        const harness = createHarness({ responses: [textResponse('done')] });

        await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [SEARCH_TOOL, READ_TOOL],
            recurseLimit: 5,
            ...harness.deps,
        });

        expect(harness.requests[0].tools).toEqual([SEARCH_TOOL, READ_TOOL]);
        expect(harness.requests[0].tools.every(tool => tool.type === 'function' && !('input_schema' in tool))).toBe(true);
    });

    test('invokes tool calls, appends call and result turns, and sends again until a plain answer', async () => {
        const searchCall = toolCallResponse({ name: 'compendium_search' });
        const readCall = toolCallResponse({ name: 'compendium_read' }, { name: 'compendium_read' });
        const harness = createHarness({
            responses: [searchCall, readCall, textResponse('Vex hunts heretics on Gilead Primus.')],
            rounds: [
                { invocations: [invocation('call_1', 'compendium_search', { query: 'Vex' }, '[{"id":"npc-vex"}]')] },
                {
                    invocations: [
                        invocation('call_2', 'compendium_read', { id: 'npc-vex' }, '{"name":"Vex"}'),
                        invocation('call_3', 'compendium_read', { id: 'loc-gilead' }, ''),
                    ],
                },
            ],
        });

        const result = await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [SEARCH_TOOL, READ_TOOL],
            recurseLimit: 5,
            ...harness.deps,
        });

        const firstRoundTurns = [
            {
                role: 'assistant',
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'compendium_search', arguments: '{"query":"Vex"}' } }],
            },
            { role: 'tool', tool_call_id: 'call_1', content: '[{"id":"npc-vex"}]' },
        ];
        const secondRoundTurns = [
            {
                role: 'assistant',
                tool_calls: [
                    { id: 'call_2', type: 'function', function: { name: 'compendium_read', arguments: '{"id":"npc-vex"}' } },
                    { id: 'call_3', type: 'function', function: { name: 'compendium_read', arguments: '{"id":"loc-gilead"}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'call_2', content: '{"name":"Vex"}' },
            { role: 'tool', tool_call_id: 'call_3', content: '[No content]' },
        ];

        expect(harness.invokedResponses).toEqual([searchCall, readCall]);
        expect(harness.requests.map(request => request.messages)).toEqual([
            BASE_MESSAGES,
            [...BASE_MESSAGES, ...firstRoundTurns],
            [...BASE_MESSAGES, ...firstRoundTurns, ...secondRoundTurns],
        ]);
        expect(harness.requests.every(request => request.tool_choice === 'auto')).toBe(true);
        expect(result.text).toBe('Vex hunts heretics on Gilead Primus.');
        expect(result.invocations.map(i => i.id)).toEqual(['call_1', 'call_2', 'call_3']);
        expect(result.requestCount).toBe(3);
        expect(result.stopReason).toBe('final');
    });

    test('strips tools at the recursion ceiling to force a plain-text answer', async () => {
        const harness = createHarness({
            responses: [
                toolCallResponse({ name: 'compendium_search' }),
                toolCallResponse({ name: 'compendium_search' }),
                { text: 'Best answer so far.', calls: [{ name: 'compendium_search' }] },
            ],
            rounds: [
                { invocations: [invocation('call_1', 'compendium_search', { query: 'a' }, 'r1')] },
                { invocations: [invocation('call_2', 'compendium_search', { query: 'b' }, 'r2')] },
            ],
        });

        const result = await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [SEARCH_TOOL],
            recurseLimit: 3,
            ...harness.deps,
        });

        expect(harness.requests).toHaveLength(3);
        expect(harness.requests[0]).toHaveProperty('tools');
        expect(harness.requests[1]).toHaveProperty('tools');
        expect(harness.requests[2]).not.toHaveProperty('tools');
        expect(harness.requests[2]).not.toHaveProperty('tool_choice');
        expect(harness.invokedResponses).toHaveLength(2);
        expect(result.text).toBe('Best answer so far.');
        expect(result.stopReason).toBe('limit');
        expect(result.requestCount).toBe(3);
    });

    test('a recursion limit of 1 sends a single tool-less request', async () => {
        const harness = createHarness({ responses: [textResponse('plain')] });

        const result = await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [SEARCH_TOOL],
            recurseLimit: 1,
            ...harness.deps,
        });

        expect(harness.requests).toEqual([{ messages: BASE_MESSAGES }]);
        expect(result.stopReason).toBe('limit');
    });

    test('normalizes an invalid recursion limit to the runtime default', async () => {
        const harness = createHarness({
            responses: [...Array(4)].map(() => toolCallResponse({ name: 'compendium_search' })).concat(textResponse('forced')),
            rounds: [...Array(4)].map((_, index) => ({ invocations: [invocation(`call_${index}`, 'compendium_search', {}, 'r')] })),
        });

        const result = await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [SEARCH_TOOL],
            recurseLimit: 'nope',
            ...harness.deps,
        });

        expect(result.requestCount).toBe(5);
        expect(harness.requests[4]).not.toHaveProperty('tools');
        expect(result.stopReason).toBe('limit');
    });

    test('stops after a stealth tool call and keeps stealth calls out of the invocation list', async () => {
        const harness = createHarness({
            responses: [toolCallResponse({ name: 'visible' }, { name: 'hidden' })],
            rounds: [{
                invocations: [invocation('call_1', 'visible', {}, 'ok')],
                stealthCalls: ['hidden'],
            }],
        });

        const result = await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [SEARCH_TOOL],
            recurseLimit: 5,
            ...harness.deps,
        });

        expect(harness.requests).toHaveLength(1);
        expect(result.invocations.map(i => i.name)).toEqual(['visible']);
        expect(result.stealthCalls).toEqual(['hidden']);
        expect(result.stopReason).toBe('stealth');
    });

    test('stops when tool calls produce no invocations instead of resending the same request', async () => {
        const harness = createHarness({
            responses: [{ text: 'partial', calls: [{ name: 'unknown' }] }],
            rounds: [{ invocations: [] }],
        });

        const result = await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [SEARCH_TOOL],
            recurseLimit: 5,
            ...harness.deps,
        });

        expect(harness.requests).toHaveLength(1);
        expect(result.text).toBe('partial');
        expect(result.stopReason).toBe('no-invocations');
    });

    test('sends failed tool invocations back to the model and reports their errors', async () => {
        const failure = new Error('Entry not found');
        const harness = createHarness({
            responses: [toolCallResponse({ name: 'compendium_read' }), textResponse('Could not find that entry.')],
            rounds: [{
                invocations: [invocation('call_1', 'compendium_read', { id: 'x' }, 'Error: Entry not found', { error: true })],
                errors: [failure],
            }],
        });

        const result = await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [READ_TOOL],
            recurseLimit: 5,
            ...harness.deps,
        });

        expect(harness.requests[1].messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Error: Entry not found' });
        expect(result.errors).toEqual([failure]);
        expect(result.invocations[0].error).toBe(true);
    });

    test('carries tool call signatures on the assistant tool-call turn', async () => {
        const harness = createHarness({
            responses: [toolCallResponse({ name: 'compendium_search' }), textResponse('done')],
            rounds: [{ invocations: [invocation('call_1', 'compendium_search', {}, 'r', { signature: 'sig-1' })] }],
        });

        await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [SEARCH_TOOL],
            recurseLimit: 5,
            ...harness.deps,
        });

        expect(harness.requests[1].messages.at(-2).tool_calls[0].signature).toBe('sig-1');
    });

    test('does not mutate the caller message list', async () => {
        const messages = structuredClone(BASE_MESSAGES);
        const harness = createHarness({
            responses: [toolCallResponse({ name: 'compendium_search' }), textResponse('done')],
            rounds: [{ invocations: [invocation('call_1', 'compendium_search', {}, 'r')] }],
        });

        await runAgentToolCallLoop({
            messages,
            tools: [SEARCH_TOOL],
            recurseLimit: 5,
            ...harness.deps,
        });

        expect(messages).toEqual(BASE_MESSAGES);
    });

    test('sends without tools and never detects tool calls when no tools are given', async () => {
        const harness = createHarness({ responses: [{ text: 'plain', calls: [{ name: 'ignored' }] }] });

        const result = await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: [],
            recurseLimit: 5,
            ...harness.deps,
        });

        expect(harness.requests).toEqual([{ messages: BASE_MESSAGES }]);
        expect(harness.invokedResponses).toHaveLength(0);
        expect(result.text).toBe('plain');
        expect(result.stopReason).toBe('final');
    });
});

describe('isAgentToolCallingEnabled', () => {
    const toolCalling = { enabled: true };

    test('is off for agents saved before the setting existed or with a non-boolean flag', () => {
        expect(isAgentToolCallingEnabled({ category: 'companion', execution: 'companion' })).toBe(false);
        expect(isAgentToolCallingEnabled({ category: 'companion', execution: 'companion', toolCalling: { enabled: 'yes' } })).toBe(false);
    });

    test('applies to companions, context intercepts, and post-generation rewrites', () => {
        expect(isAgentToolCallingEnabled({ category: 'companion', toolCalling })).toBe(true);
        expect(isAgentToolCallingEnabled({ category: 'tracker', execution: 'companion', toolCalling })).toBe(true);
        expect(isAgentToolCallingEnabled({ category: 'custom', preProcess: { mode: 'intercept' }, toolCalling })).toBe(true);
        expect(isAgentToolCallingEnabled({ category: 'content', postProcess: { promptTransformEnabled: true }, toolCalling })).toBe(true);
    });

    test('never applies to tool-category agents or plain inject agents', () => {
        expect(isAgentToolCallingEnabled({ category: 'tool', preProcess: { mode: 'intercept' }, toolCalling })).toBe(false);
        expect(isAgentToolCallingEnabled({ category: 'custom', preProcess: { mode: 'inject' }, toolCalling })).toBe(false);
    });
});

describe('resolveAgentToolCallingPlan', () => {
    const COMPANION_AGENT = { category: 'companion', execution: 'companion', toolCalling: { enabled: true } };
    const PROFILE = { id: 'profile-1', api: 'claude', model: 'claude-sonnet' };
    const CLAUDE_API = { selected: 'openai', source: 'claude' };

    function planOptions(overrides = {}) {
        const calls = { isSupported: [], getTools: 0 };
        return {
            calls,
            options: {
                agent: COMPANION_AGENT,
                batched: false,
                profile: PROFILE,
                apiMap: CLAUDE_API,
                mainApi: 'openai',
                isSupported: (profile, apiMap) => {
                    calls.isSupported.push([profile, apiMap]);
                    return true;
                },
                getTools: async () => {
                    calls.getTools++;
                    return [SEARCH_TOOL];
                },
                ...overrides,
            },
        };
    }

    test('enables with every registered tool, checking support against the agent profile', async () => {
        const { calls, options } = planOptions();

        const plan = await resolveAgentToolCallingPlan(options);

        expect(plan).toEqual({ status: 'enabled', tools: [SEARCH_TOOL] });
        expect(calls.isSupported).toEqual([[PROFILE, CLAUDE_API]]);
        expect(summarizeAgentToolCallingPlan(plan)).toEqual({ status: 'enabled' });
    });

    test('disabled agents never probe support or collect tools', async () => {
        const { calls, options } = planOptions({ agent: { ...COMPANION_AGENT, toolCalling: { enabled: false } } });

        expect(await resolveAgentToolCallingPlan(options)).toEqual({ status: 'disabled', tools: [] });
        expect(calls.isSupported).toHaveLength(0);
        expect(calls.getTools).toBe(0);
    });

    const skipCases = [
        ['the request is batched', { batched: true }, AGENT_TOOL_CALLING_SKIP_REASONS.BATCHED_REQUEST],
        ['there is no connection profile', { profile: null, apiMap: null }, AGENT_TOOL_CALLING_SKIP_REASONS.NO_CONNECTION_PROFILE],
        ['the profile is text completion', { apiMap: { selected: 'textgenerationwebui', type: 'ooba' } }, AGENT_TOOL_CALLING_SKIP_REASONS.NOT_CHAT_COMPLETION],
        ['the main API is not chat completion', { mainApi: 'textgenerationwebui' }, AGENT_TOOL_CALLING_SKIP_REASONS.MAIN_API_NOT_CHAT_COMPLETION],
        ['the backend lacks function calling', { isSupported: () => false }, AGENT_TOOL_CALLING_SKIP_REASONS.FUNCTION_CALLING_UNSUPPORTED],
        ['no tools are registered', { getTools: async () => [] }, AGENT_TOOL_CALLING_SKIP_REASONS.NO_REGISTERED_TOOLS],
    ];

    for (const [label, overrides, reason] of skipCases) {
        test(`skips with a reason instead of throwing when ${label}`, async () => {
            const { options } = planOptions(overrides);

            const plan = await resolveAgentToolCallingPlan(options);

            expect(plan).toEqual({ status: 'skipped', reason, tools: [] });
            expect(summarizeAgentToolCallingPlan(plan)).toEqual({ status: 'skipped', reason });
        });
    }
});

describe('filterAgentToolSelection', () => {
    const ALL_TOOLS = [SEARCH_TOOL, READ_TOOL, PATHFINDER_ROLL_TOOL];

    test('an agent left on "all" (the default) keeps every currently registered tool', () => {
        expect(filterAgentToolSelection({ toolCalling: { mode: 'all' } }, ALL_TOOLS)).toBe(ALL_TOOLS);
        expect(filterAgentToolSelection({ toolCalling: {} }, ALL_TOOLS)).toBe(ALL_TOOLS);
        expect(filterAgentToolSelection({}, ALL_TOOLS)).toBe(ALL_TOOLS);
    });

    test('an explicit selection excludes every other currently registered tool', () => {
        const agent = { toolCalling: { mode: 'selected', selectedTools: ['compendium_search', 'compendium_read'] } };

        expect(filterAgentToolSelection(agent, ALL_TOOLS)).toEqual([SEARCH_TOOL, READ_TOOL]);
    });

    test('an explicit selection naming an unregistered tool yields no match for it', () => {
        const agent = { toolCalling: { mode: 'selected', selectedTools: ['nonexistent_tool'] } };

        expect(filterAgentToolSelection(agent, ALL_TOOLS)).toEqual([]);
    });

    test('an empty explicit selection attaches no tools even though tools are registered', () => {
        const agent = { toolCalling: { mode: 'selected', selectedTools: [] } };

        expect(filterAgentToolSelection(agent, ALL_TOOLS)).toEqual([]);
    });
});

describe('an agent scoped to one extension\'s tools via explicit selection', () => {
    test('never calls another extension\'s tool even though it is registered', async () => {
        const agent = {
            category: 'companion',
            execution: 'companion',
            toolCalling: { enabled: true, mode: 'selected', selectedTools: ['compendium_search', 'compendium_read'] },
        };
        const PROFILE = { id: 'profile-1', api: 'claude', model: 'claude-sonnet' };
        const CLAUDE_API = { selected: 'openai', source: 'claude' };

        const plan = await resolveAgentToolCallingPlan({
            agent,
            profile: PROFILE,
            apiMap: CLAUDE_API,
            mainApi: 'openai',
            isSupported: () => true,
            // Simulates two tool-providing extensions both currently registered with the shared tool manager.
            getTools: async () => filterAgentToolSelection(agent, [SEARCH_TOOL, READ_TOOL, PATHFINDER_ROLL_TOOL]),
        });

        expect(plan.status).toBe('enabled');
        expect(plan.tools).toEqual([SEARCH_TOOL, READ_TOOL]);

        const rollCall = toolCallResponse({ name: 'pathfinder_roll' });
        const harness = createHarness({
            responses: [rollCall, textResponse('Vex hunts heretics on Gilead Primus.')],
            rounds: [{ invocations: [] }],
        });

        const result = await runAgentToolCallLoop({
            messages: BASE_MESSAGES,
            tools: plan.tools,
            recurseLimit: 5,
            ...harness.deps,
        });

        for (const request of harness.requests) {
            expect(request.tools ?? []).not.toContainEqual(PATHFINDER_ROLL_TOOL);
        }
        expect(result.invocations.some(invoked => invoked.name === 'pathfinder_roll')).toBe(false);
    });
});
