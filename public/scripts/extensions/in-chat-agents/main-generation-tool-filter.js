/**
 * Pure filter that keeps agent-only tools out of main generation's own
 * request while leaving them available to tool-calling agents. Agent
 * requests collect their own tools independently through ToolManager and
 * never pass through this filter, so hiding a tool here only affects what
 * main generation itself sees. See .scratch/agent-tool-calling/issues/08.
 */

/**
 * @param {object[]} tools OpenAI-format function tools
 * @param {Set<string>|string[]} [hiddenToolNames]
 * @returns {object[]}
 */
export function excludeHiddenToolsFromMainGeneration(tools, hiddenToolNames) {
    if (!Array.isArray(tools) || tools.length === 0) {
        return tools;
    }

    const hidden = hiddenToolNames instanceof Set ? hiddenToolNames : new Set(hiddenToolNames ?? []);
    if (hidden.size === 0) {
        return tools;
    }

    return tools.filter(tool => !hidden.has(tool?.function?.name));
}
