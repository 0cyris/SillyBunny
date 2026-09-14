import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = relativePath => readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8');

const runnerSource = readSource('public/scripts/extensions/in-chat-agents/agent-runner.js');
const storeSource = readSource('public/scripts/extensions/in-chat-agents/agent-store.js');
const indexSource = readSource('public/scripts/extensions/in-chat-agents/index.js');
const settingsHtml = readSource('public/scripts/extensions/in-chat-agents/settings.html');

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

describe('keep agent-only tools out of main generation', () => {
    test('the agent store exposes a hidden main-generation tool-name setting', () => {
        expect(storeSource).toContain('hiddenMainGenerationToolNames: [],');
        expect(storeSource).toContain('globalSettings.hiddenMainGenerationToolNames = normalizeAgentIdCollection(globalSettings.hiddenMainGenerationToolNames);');
        expect(storeSource).toContain('export function getHiddenMainGenerationToolNames()');
        expect(storeSource).toContain('export function setHiddenMainGenerationToolNames(names)');
    });

    test('the runner imports the pure filter and the hidden-name getter', () => {
        expect(runnerSource).toContain('import { excludeHiddenToolsFromMainGeneration } from \'./main-generation-tool-filter.js\';');
        expect(runnerSource).toContain('    getHiddenMainGenerationToolNames,\n');
    });

    test('onChatCompletionSettingsReady runs even with no tool-category agents when tools are hidden, and filters before forcing tool_choice', () => {
        const source = getFunctionSource(runnerSource, 'onChatCompletionSettingsReady');

        expect(source).toContain('const hiddenToolNames = getHiddenMainGenerationToolNames();');
        // The old gating alone (no tool-category agents registered) no longer short-circuits
        // the handler when a hidden-tools list is configured.
        expect(source).toContain('(agentRegisteredToolNames.size === 0 && hiddenToolNames.size === 0)');
        expect(source).toContain('data.tools = excludeHiddenToolsFromMainGeneration(data.tools, hiddenToolNames);');
        expect(source).toContain('if (data.tools.length === 0) {');
        // Forcing tool_choice must not resurrect an empty tools list the filter just removed.
        expect(source).toContain('if (toolRecursionDepth === 0 && data.tools && getPathfinderRuntimeAgent()) {');
    });

    test('a tool-calling agent\'s own request never runs through the hidden-tools filter', () => {
        const source = getFunctionSource(runnerSource, 'resolveAgentRequestToolCalling');

        expect(source).not.toContain('excludeHiddenToolsFromMainGeneration');
        expect(source).not.toContain('getHiddenMainGenerationToolNames');
    });

    test('the settings panel offers a hidden-tools picker wired to the dedicated setter', () => {
        expect(settingsHtml).toContain('id="ica--hiddenMainGenerationToolNames"');
        expect(indexSource).toContain('async function populateHiddenMainGenerationToolNamesSelect()');
        expect(indexSource).toContain('const hiddenNames = getHiddenMainGenerationToolNames();');
        expect(indexSource).toContain('$(\'#ica--hiddenMainGenerationToolNames\').on(\'change\', function () {');
        expect(indexSource).toContain('setHiddenMainGenerationToolNames($(this).val() ?? []);');
    });
});
