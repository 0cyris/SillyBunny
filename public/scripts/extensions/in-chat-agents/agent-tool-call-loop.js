import { TOOL_CALL_RECURSE_LIMIT_DEFAULT, normalizeToolCallRecurseLimit } from '../../tool-call-recurse-limit.js';

export const AGENT_TOOL_CALLING_SKIP_REASONS = Object.freeze({
    BATCHED_REQUEST: 'batched-request',
    NO_CONNECTION_PROFILE: 'no-connection-profile',
    NOT_CHAT_COMPLETION: 'not-chat-completion',
    MAIN_API_NOT_CHAT_COMPLETION: 'main-api-not-chat-completion',
    FUNCTION_CALLING_UNSUPPORTED: 'function-calling-unsupported',
    NO_REGISTERED_TOOLS: 'no-registered-tools',
});

/**
 * @typedef {object} AgentToolCallingPlan
 * @property {'disabled' | 'skipped' | 'enabled'} status
 * @property {string} [reason] One of AGENT_TOOL_CALLING_SKIP_REASONS when skipped
 * @property {object[]} tools OpenAI-format function tools to attach; empty unless enabled
 */

/**
 * Whether an agent opted into tool calling and runs a request of its own:
 * companions, context intercepts, and post-generation prompt rewrites.
 * Tool-category agents contribute tools to main generation instead.
 * @param {any} agent
 * @returns {boolean}
 */
export function isAgentToolCallingEnabled(agent) {
    if (agent?.toolCalling?.enabled !== true || agent.category === 'tool') {
        return false;
    }

    const isCompanion = agent.execution === 'companion' || agent.category === 'companion';
    const isContextIntercept = agent.preProcess?.mode === 'intercept';
    const isPromptRewrite = Boolean(agent.postProcess?.promptTransformEnabled);
    return isCompanion || isContextIntercept || isPromptRewrite;
}

/**
 * Restricts OpenAI-format function tools to an agent's explicit selection.
 * Agents left on "all" (the default) see every currently registered tool.
 * @param {any} agent
 * @param {object[]} tools OpenAI-format function tools
 * @returns {object[]}
 */
export function filterAgentToolSelection(agent, tools) {
    if (agent?.toolCalling?.mode !== 'selected') {
        return tools;
    }

    const selectedNames = new Set(
        Array.isArray(agent.toolCalling.selectedTools) ? agent.toolCalling.selectedTools : [],
    );
    return tools.filter(tool => selectedNames.has(tool?.function?.name));
}

/**
 * Decides whether an agent request attaches tools, reporting a skip reason instead of throwing.
 * @param {object} options
 * @param {any} options.agent
 * @param {boolean} [options.batched] Whether the request serves several agents at once
 * @param {any} [options.profile] Resolved connection profile, or null when the request uses the main connection
 * @param {{ selected?: string, source?: string } | null} [options.apiMap] CONNECT_API_MAP entry for the profile
 * @param {string} [options.mainApi]
 * @param {(profile: any, apiMap: { selected?: string, source?: string }) => boolean} options.isSupported
 * @param {() => Promise<object[]>} options.getTools
 * @returns {Promise<AgentToolCallingPlan>}
 */
export async function resolveAgentToolCallingPlan({ agent, batched = false, profile = null, apiMap = null, mainApi = '', isSupported, getTools }) {
    if (!isAgentToolCallingEnabled(agent)) {
        return { status: 'disabled', tools: [] };
    }

    const skip = reason => ({ status: 'skipped', reason, tools: [] });

    if (batched) {
        return skip(AGENT_TOOL_CALLING_SKIP_REASONS.BATCHED_REQUEST);
    }

    if (!profile) {
        return skip(AGENT_TOOL_CALLING_SKIP_REASONS.NO_CONNECTION_PROFILE);
    }

    if (apiMap?.selected !== 'openai' || !apiMap.source) {
        return skip(AGENT_TOOL_CALLING_SKIP_REASONS.NOT_CHAT_COMPLETION);
    }

    if (mainApi !== 'openai') {
        return skip(AGENT_TOOL_CALLING_SKIP_REASONS.MAIN_API_NOT_CHAT_COMPLETION);
    }

    if (!isSupported(profile, apiMap)) {
        return skip(AGENT_TOOL_CALLING_SKIP_REASONS.FUNCTION_CALLING_UNSUPPORTED);
    }

    const tools = await getTools();
    if (!Array.isArray(tools) || tools.length === 0) {
        return skip(AGENT_TOOL_CALLING_SKIP_REASONS.NO_REGISTERED_TOOLS);
    }

    return { status: 'enabled', tools };
}

/**
 * @param {AgentToolCallingPlan} plan
 * @returns {{ status: string, reason?: string }}
 */
export function summarizeAgentToolCallingPlan(plan) {
    return plan.reason ? { status: plan.status, reason: plan.reason } : { status: plan.status };
}

/**
 * @typedef {object} AgentToolCallRequest
 * @property {object[]} messages Chat completion messages for this send
 * @property {object[]} [tools] OpenAI-format function tools; absent on tool-less sends
 * @property {'auto'} [tool_choice] Present only when tools are attached
 */

/**
 * @typedef {object} AgentToolInvocationRound
 * @property {import('../../tool-calling.js').ToolInvocation[]} invocations
 * @property {Error[]} [errors]
 * @property {string[]} [stealthCalls]
 */

/**
 * @typedef {object} AgentToolCallLoopResult
 * @property {string} text Final response text
 * @property {import('../../tool-calling.js').ToolInvocation[]} invocations Non-stealth invocations across all rounds
 * @property {Error[]} errors
 * @property {string[]} stealthCalls
 * @property {number} requestCount
 * @property {'final' | 'limit' | 'stealth' | 'no-invocations'} stopReason
 */

/**
 * Runs an isolated tool-call round trip for an agent request. Intermediate
 * tool-call and tool-result turns exist only inside this call.
 * @param {object} options
 * @param {object[]} options.messages Initial chat completion messages
 * @param {object[]} options.tools OpenAI-format function tools, sent unmodified
 * @param {unknown} [options.recurseLimit] Maximum number of sends, including the forced tool-less one
 * @param {(request: AgentToolCallRequest) => Promise<any>} options.send
 * @param {(response: any) => boolean} options.hasToolCalls
 * @param {(response: any) => Promise<AgentToolInvocationRound>} options.invokeTools
 * @param {(response: any) => string} options.getText
 * @returns {Promise<AgentToolCallLoopResult>}
 */
export async function runAgentToolCallLoop({
    messages,
    tools,
    recurseLimit = TOOL_CALL_RECURSE_LIMIT_DEFAULT,
    send,
    hasToolCalls,
    invokeTools,
    getText,
}) {
    const limit = normalizeToolCallRecurseLimit(recurseLimit);
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const conversation = [...messages];
    const invocations = [];
    const errors = [];
    const stealthCalls = [];
    let requestCount = 0;

    const finish = (text, stopReason) => ({ text, invocations, errors, stealthCalls, requestCount, stopReason });

    while (true) {
        // Mirrors main generation's ceiling: the pass at depth `limit - 1` goes out without tools.
        const atLimit = hasTools && requestCount >= limit - 1;
        const attachTools = hasTools && !atLimit;
        const request = attachTools
            ? { messages: [...conversation], tools, tool_choice: 'auto' }
            : { messages: [...conversation] };

        const response = await send(request);
        requestCount++;
        const text = getText(response);

        if (!attachTools) {
            return finish(text, atLimit ? 'limit' : 'final');
        }

        if (!hasToolCalls(response)) {
            return finish(text, 'final');
        }

        const round = await invokeTools(response);
        const roundInvocations = round.invocations ?? [];
        invocations.push(...roundInvocations);
        errors.push(...(round.errors ?? []));
        stealthCalls.push(...(round.stealthCalls ?? []));

        if (round.stealthCalls?.length) {
            return finish(text, 'stealth');
        }

        if (roundInvocations.length === 0) {
            return finish(text, 'no-invocations');
        }

        conversation.push({
            role: 'assistant',
            tool_calls: roundInvocations.map(invocation => ({
                id: invocation.id,
                type: 'function',
                function: {
                    name: invocation.name,
                    arguments: invocation.parameters,
                },
                ...(invocation.signature ? { signature: invocation.signature } : {}),
            })),
        });

        for (const invocation of roundInvocations) {
            conversation.push({
                role: 'tool',
                tool_call_id: invocation.id,
                content: invocation.result || '[No content]',
            });
        }
    }
}

/**
 * @typedef {object} AgentToolCallHistoryEntry
 * @property {string} name Display name (falling back to the registration name)
 * @property {string} [result] Present for a successful invocation
 * @property {string} [error] Present for a failed invocation
 */

/**
 * Reduces a run's tool-calling outcome to entries safe for an agent's
 * execution history: the tool name and its result or error, one per
 * invocation. Stealth invocations never reach this list — the loop's
 * `invocations` array already excludes them, keeping them out of any
 * history storage exactly as they're kept out of the chat/model transcript.
 * @param {{ invocations?: import('../../tool-calling.js').ToolInvocation[] } | null | undefined} toolCalling
 * @returns {AgentToolCallHistoryEntry[]}
 */
export function buildAgentToolCallHistoryEntries(toolCalling) {
    if (!toolCalling || !Array.isArray(toolCalling.invocations)) {
        return [];
    }

    return toolCalling.invocations.map(invocation => {
        const name = invocation?.displayName || invocation?.name || '';
        const outcome = String(invocation?.result ?? '');
        return invocation?.error ? { name, error: outcome } : { name, result: outcome };
    });
}
