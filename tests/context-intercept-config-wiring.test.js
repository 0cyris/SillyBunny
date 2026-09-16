import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = relativePath => readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8');

const runnerSource = readSource('public/scripts/extensions/in-chat-agents/agent-runner.js');
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

describe('context intercept config wiring', () => {
    test('the agent runner imports every helper from the pure config module', () => {
        expect(runnerSource).toContain('} from \'./context-intercept-config.js\';');
        expect(runnerSource).toContain('    isInsertOutputOnlyIntercept,\n');
        expect(runnerSource).toContain('    normalizeInterceptApplyMode,\n');
        expect(runnerSource).toContain('    resolveContextInterceptScope,\n');
        expect(runnerSource).toContain('    selectContextInterceptInstruction,\n');
        expect(runnerSource).toContain('    selectRecentChatMessages,\n');
    });

    test('the repeated apply-mode normalization ternary is gone in favor of the one helper', () => {
        expect(runnerSource).not.toContain('[\'wrap\', \'patch\'].includes');
        expect(countOccurrences(runnerSource, 'normalizeInterceptApplyMode(')).toBeGreaterThanOrEqual(6);
    });

    test('buildContextInterceptMessages selects its instruction through the helper and forwards insertOutputOnly', () => {
        const source = getFunctionSource(runnerSource, 'buildContextInterceptMessages');

        expect(source).toContain('insertOutputOnly = false) {');
        expect(countOccurrences(source, 'selectContextInterceptInstruction({ timing, insertOutputOnly })')).toBe(2);
    });

    test('applyContextInterceptText normalizes applyMode through the helper', () => {
        const source = getFunctionSource(runnerSource, 'applyContextInterceptText');

        expect(source).toContain('const applyMode = normalizeInterceptApplyMode(preProcess.applyMode);');
    });

    test('runContextInterceptAgent resolves scope and insert-output-only, and never lets scoping touch the inserted context', () => {
        const source = getFunctionSource(runnerSource, 'runContextInterceptAgent');

        expect(source).toContain('const applyMode = normalizeInterceptApplyMode(agent?.preProcess?.applyMode);');
        expect(source).toContain('const insertOutputOnly = isInsertOutputOnlyIntercept(agent?.preProcess, timing);');
        expect(source).toContain('const contextScope = resolveContextInterceptScope({');
        expect(source).toContain('const agentContextText = typeof options.promptContextText === \'string\' ? options.promptContextText : currentContextText;');
        expect(source).toContain('buildContextInterceptMessages(expandedPrompt, agentContextText, generationType, contextFormat, timing, insertOutputOnly)');
        // baseResult carries both flags so the run-history label and sanitizer can see them
        expect(source).toContain('insertOutputOnly,');
        expect(source).toContain('contextScope,');
    });

    test('runPreGenerationInterceptorsOnChat scopes only the agent\'s own request, not the chat sent to the main model', () => {
        const source = getFunctionSource(runnerSource, 'runPreGenerationInterceptorsOnChat');

        expect(source).toContain('const scope = resolveContextInterceptScope({');
        expect(source).toContain('selectRecentChatMessages(currentChatMessages, agent?.preProcess?.contextRecentMessages)');
        expect(source).toContain('runContextInterceptAgent(agent, contextText, activationSnapshot.generationType, \'chat\', { promptContextText, promptChatMessages });');
    });

    test('runContextInterceptAgent builds an own-preset request only from the chat path\'s scoped messages, falling back to context on failure', () => {
        const source = getFunctionSource(runnerSource, 'runContextInterceptAgent');

        expect(runnerSource).toContain('    appendOwnPresetAgentTurn,\n');
        expect(runnerSource).toContain('    resolveContextInterceptPromptSource,\n');
        expect(source).toContain('const promptSource = Array.isArray(options.promptChatMessages)');
        expect(source).toContain('promptSource: agent?.preProcess?.promptSource,');
        expect(source).toContain('buildOwnPresetInterceptMessages(agent, {');
        expect(source).toContain('extractOwnPresetHistoryMessages(options.promptChatMessages)');
        expect(source).toContain('ownPresetFallbackReason = ownPreset.reason;');
        expect(source).toContain('promptSource,');
        expect(runnerSource).toContain('buildOwnPresetChatMessages(');

        const textSource = getFunctionSource(runnerSource, 'runPreGenerationInterceptorsOnText');
        expect(textSource).not.toContain('promptChatMessages');
    });

    test('the sanitizer and run-history label record the prompt source and any fallback reason', () => {
        const sanitizer = getFunctionSource(runnerSource, 'sanitizePreGenerationInterceptRunForStorage');
        expect(sanitizer).toContain('promptSource: result.promptSource === \'own-preset\' ? \'own-preset\' : \'context\',');
        expect(sanitizer).toContain('promptSourceFallbackReason');

        const label = getFunctionSource(indexSource, 'getPreGenerationInterceptModeLabel');
        expect(label).toContain('entry?.promptSource === \'own-preset\'');
        expect(label).toContain('entry?.promptSourceFallbackReason');
    });

    test('the editor exposes the prompt source only for insert-output-only intercepts', () => {
        expect(editorHtml).toContain('id="ica--editor-pre-promptSource"');
        expect(editorHtml).toContain('<option value="own-preset">Agent prompt + the agent\'s own preset</option>');
        expect(indexSource).toContain('editorEl.find(\'#ica--editor-pre-promptSource\').val(preProcess.promptSource === \'own-preset\' ? \'own-preset\' : \'context\');');
        expect(indexSource).toContain('promptSource: editorEl.find(\'#ica--editor-pre-promptSource\').val()?.toString() === \'own-preset\' ? \'own-preset\' : \'context\',');

        const visibilitySource = getFunctionSource(indexSource, 'updatePreProcessVisibility');
        expect(visibilitySource).toContain('editorEl.find(\'#ica--pre-prompt-source-row\').toggle(interceptVisible && rawApplyMode === \'wrap-insert-output-only\');');
    });

    test('prompt assembly tags every emitted chat message with its segment and keeps injections marked', () => {
        const openaiSource = readSource('public/scripts/openai.js');

        expect(openaiSource).toContain('import { classifyChatCompletionMessage, tagPromptSegment } from \'./openai-prompt-segments.js\';');
        expect(countOccurrences(openaiSource, 'classifyChatCompletionMessage(')).toBe(2);
        expect(getFunctionSource(openaiSource, 'populateChatHistory')).toContain('if (chatPrompt.injected === true) {\n                message.injected = true;');
        expect(openaiSource).toContain('if (message.injected === true) {\n                        lastMessage.injected = true;');
    });

    test('the pre-generation intercept sanitizer preserves insertOutputOnly and contextScope for storage', () => {
        const source = getFunctionSource(runnerSource, 'sanitizePreGenerationInterceptRunForStorage');

        expect(source).toContain('insertOutputOnly: Boolean(result.insertOutputOnly),');
        expect(source).toContain('contextScope: result.contextScope === \'recent\' ? \'recent\' : \'full\',');
    });

    test('the run-history mode label distinguishes insert-output-only from plain wrap', () => {
        const source = getFunctionSource(indexSource, 'getPreGenerationInterceptModeLabel');

        expect(source).toContain('entry?.insertOutputOnly === true ? `${timing} insert-output-only` : `${timing} wrap`');
    });

    test('the editor offers insert-output-only as a distinct Apply Mode option, saved as wrap + a flag', () => {
        expect(editorHtml).toContain('<option value="wrap-insert-output-only">Wrap / insert output only</option>');
        expect(indexSource).toContain('editorEl.find(\'#ica--editor-pre-applyMode\').val(');
        expect(indexSource).toContain('preProcess.applyMode === \'wrap\' && preProcess.insertOutputOnly === true ? \'wrap-insert-output-only\' : preProcess.applyMode,');

        const visibilitySource = getFunctionSource(indexSource, 'updatePreProcessVisibility');
        expect(visibilitySource).toContain('const isWrapApplyMode = rawApplyMode === \'wrap\' || rawApplyMode === \'wrap-insert-output-only\';');

        expect(indexSource).toContain('const editorInsertOutputOnly = rawEditorApplyMode === \'wrap-insert-output-only\';');
        expect(indexSource).toContain('applyMode: editorInsertOutputOnly ? \'wrap\' : normalizeInterceptApplyMode(rawEditorApplyMode),');
        expect(indexSource).toContain('insertOutputOnly: editorInsertOutputOnly,');
    });

    test('the editor exposes context scope and message count, hidden for replace mode', () => {
        expect(editorHtml).toContain('id="ica--editor-pre-contextScope"');
        expect(editorHtml).toContain('id="ica--editor-pre-contextRecentMessages"');
        expect(indexSource).toContain('editorEl.find(\'#ica--editor-pre-contextScope\').val(preProcess.contextScope === \'recent\' ? \'recent\' : \'full\');');
        expect(indexSource).toContain('contextScope: editorEl.find(\'#ica--editor-pre-contextScope\').val()?.toString() === \'recent\' ? \'recent\' : \'full\',');
        expect(indexSource).toContain('contextRecentMessages: Number(editorEl.find(\'#ica--editor-pre-contextRecentMessages\').val()) || DEFAULT_CONTEXT_RECENT_MESSAGES,');

        const visibilitySource = getFunctionSource(indexSource, 'updatePreProcessVisibility');
        expect(visibilitySource).toContain('const scopeControlVisible = interceptVisible && applyMode !== \'replace\';');
        expect(visibilitySource).toContain('editorEl.find(\'#ica--pre-context-scope-row\').toggle(scopeControlVisible);');
    });
});
