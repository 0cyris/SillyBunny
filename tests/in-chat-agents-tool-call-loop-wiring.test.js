import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = relativePath => readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8');

const runnerSource = readSource('public/scripts/extensions/in-chat-agents/agent-runner.js');
const companionRunnerSource = readSource('public/scripts/extensions/in-chat-agents/companion/companion-runner.js');
const indexSource = readSource('public/scripts/extensions/in-chat-agents/index.js');
const editorHtml = readSource('public/scripts/extensions/in-chat-agents/editor.html');

function getFunctionSource(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = source.indexOf(') {', start) + 2;
    let depth = 0;

    for (let index = bodyStart; index < source.length; index++) {
        const char = source[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

function countOccurrences(source, needle) {
    return source.split(needle).length - 1;
}

describe('agent tool call loop wiring', () => {
    test('the agent runner imports the loop module', () => {
        expect(runnerSource).toContain('} from \'./agent-tool-call-loop.js\';');
        expect(runnerSource).toContain('    runAgentToolCallLoop,\n');
        expect(runnerSource).toContain('    resolveAgentToolCallingPlan,\n');
    });

    test('every agent request resolves the per-agent plan and reports it on the response', () => {
        const source = getFunctionSource(runnerSource, 'requestPromptTransform');

        expect(source).toContain('await resolveAgentRequestToolCalling(agent, profileId, modelOverride, options, context)');
        expect(source).toContain('requestAbortController.signal, toolCallingPlan.tools)');
        expect(countOccurrences(source, 'withToolCalling(await runAllowedRequest(')).toBe(3);
        expect(source).toContain('toolCallingPlan.status === \'disabled\'');
    });

    test('the plan checks support against the agent profile and collects every registered tool', () => {
        const source = getFunctionSource(runnerSource, 'resolveAgentRequestToolCalling');

        expect(source).toContain('batched: Boolean(options.batched)');
        expect(source).toContain('context?.CONNECT_API_MAP?.[profile.api]');
        expect(source).toContain('chat_completion_source: apiMap.source');
        expect(source).toContain('function_calling: true');
        expect(source).toContain('[\'none\', undefined].includes(supportedProfile[\'prompt-post-processing\']) ? \'\'');
        expect(source).toContain('ToolManager.registerFunctionToolsOpenAI(toolData)');
    });

    test('profile requests run the isolated loop with raw responses and shared tool invocation', () => {
        const source = getFunctionSource(runnerSource, 'requestProfilePromptTransform');

        expect(source).toContain('runAgentToolCallLoop({');
        expect(source).toContain('recurseLimit: ToolManager.RECURSE_LIMIT');
        expect(source).toContain('{ ...requestOptions, extractData: false }');
        expect(source).toContain('{ tools: request.tools, tool_choice: request.tool_choice }');
        expect(source).toContain('ToolManager.hasToolCalls(response)');
        expect(source).toContain('ToolManager.invokeFunctionTools(response, { signal, isCurrent: isRuntimeAllowed })');
        expect(source).toContain('output: loopResult.text');
    });

    test('the agent loop keeps its own recursion budget and never writes tool turns into chat', () => {
        const source = getFunctionSource(runnerSource, 'requestProfilePromptTransform');

        expect(source).not.toContain('toolRecursionDepth');
        expect(source).not.toContain('saveFunctionToolInvocations');
        expect(source).not.toContain('input_schema');
    });

    test('batched companion requests are flagged so they skip tool calling', () => {
        expect(companionRunnerSource).toContain('requestPromptTransform(agents[0], promptMessages, maxTokens, { runtimeAgents: agents, batched: agents.length > 1 })');
    });

    test('the agent editor loads, saves, and preserves the tool calling setting', () => {
        expect(editorHtml).toContain('id="ica--editor-toolCalling-enabled"');
        expect(indexSource).toContain('editorEl.find(\'#ica--editor-toolCalling-enabled\').prop(\'checked\', agent.toolCalling?.enabled === true);');
        expect(indexSource).toContain('enabled: editorEl.find(\'#ica--editor-toolCalling-enabled\').prop(\'checked\') === true,');
        expect(indexSource).toContain('editorEl.find(\'#ica--tool-calling-row\').toggle(category !== \'tool\');');
        expect(getFunctionSource(indexSource, 'buildUpdatedAgentFromTemplate')).toContain('updatedAgent.toolCalling = structuredClone(agent.toolCalling ?? updatedAgent.toolCalling);');
    });

    test('the runner filters registered tools down to an agent\'s explicit selection before attaching them', () => {
        expect(runnerSource).toContain('    filterAgentToolSelection,\n');

        const source = getFunctionSource(runnerSource, 'resolveAgentRequestToolCalling');
        expect(source).toContain('return filterAgentToolSelection(agent, toolData.tools ?? []);');
    });

    test('the agent editor offers an explicit tool picker populated from the shared tool manager', () => {
        expect(editorHtml).toContain('id="ica--editor-toolCalling-mode"');
        expect(editorHtml).toContain('id="ica--editor-toolCalling-selectedTools"');
        expect(indexSource).toContain('async function getRegisteredToolNames()');
        expect(indexSource).toContain('ToolManager.registerFunctionToolsOpenAI(toolData)');
        expect(indexSource).toContain('function updateToolCallingSelectionOptions()');
        expect(indexSource).toContain('editorEl.find(\'#ica--editor-toolCalling-mode\').val(agent.toolCalling?.mode === \'selected\' ? \'selected\' : \'all\');');
        expect(indexSource).toContain('mode: editorEl.find(\'#ica--editor-toolCalling-mode\').val()?.toString() === \'selected\' ? \'selected\' : \'all\',');
        expect(indexSource).toContain('selectedTools: normalizeCompanionBatchAgentIds(editorEl.find(\'#ica--editor-toolCalling-selectedTools\').val()),');
    });
});
