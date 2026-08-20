/**
 * @fileoverview Soft tool synthesis for Anthropic-protocol surface.
 * @description Hiagent (Tongji upstream) has no native tool-use API, so we:
 *   - Render Anthropic tool definitions as a prompt suffix instructing the
 *     model to emit `<tool_use>{json}</tool_use>` when it wants to call a tool.
 *   - Parse the model's output for those blocks and convert to Anthropic
 *     `tool_use` content blocks.
 *   - Render `tool_result` and assistant `tool_use` history entries back
 *     into the prompt for multi-turn tool workflows.
 *
 * Limitations: no JSON Schema validator, no streaming input_json_delta,
 * tool_choice is honored as a hint only. See spec section 10.
 */

/**
 * @typedef {{name:string, description?:string, input_schema?:object}} AnthropicTool
 */

/**
 * Render a tool list as a prompt suffix that instructs the model how to
 * call a tool via JSON wrapped in <tool_use> tags.
 *
 * @param {AnthropicTool[]|null|undefined} tools
 * @returns {string} Prompt suffix (empty if no tools).
 */
export function toolsToPromptSuffix(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';
    const lines = [
        '[System: you may call one of the following tools to answer the user question.',
        'Format: strict JSON, immediately after your prose text, wrapped in <tool_use>...</tool_use>.]',
        '',
    ];
    tools.forEach((tool, i) => {
        if (!tool || typeof tool.name !== 'string') return;
        lines.push(`Tool ${i + 1}:`);
        lines.push(`Name: ${tool.name}`);
        if (tool.description) lines.push(`Description: ${tool.description}`);
        lines.push('Parameter schema:');
        lines.push(JSON.stringify(tool.input_schema || {}));
        lines.push('');
    });
    lines.push('[When you decide to call a tool after answering, output exactly:]');
    lines.push('<tool_use>');
    lines.push('{"name":"<tool_name>","arguments":{<args>}}');
    lines.push('</tool_use>');
    lines.push('');
    lines.push('[Do not describe the tool call outside JSON. At most one tool call per response.]');
    return lines.join('\n');
}

/**
 * Scan model output for `<tool_use>...</tool_use>` JSON blocks and
 * validate them against the provided tool list.
 *
 * @param {string} text - Full model output (after stream ends, or non-stream).
 * @param {AnthropicTool[]} tools - Tool definitions for validation.
 * @returns {{toolUses: Array<{name:string, input:object}>, warning: string|null}}
 */
export function parseToolCallsFromText(text, tools) {
    const out = { toolUses: [], warning: null };
    if (typeof text !== 'string' || !text) return out;
    const toolList = Array.isArray(tools) ? tools : [];
    const nameToTool = new Map(toolList.filter((t) => t && t.name).map((t) => [t.name, t]));
    const re = /<tool_use>([\s\S]*?)<\/tool_use>/g;
    let m;
    let malformed = 0;
    while ((m = re.exec(text)) !== null) {
        const raw = m[1].trim();
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            malformed++;
            continue;
        }
        if (!parsed || typeof parsed.name !== 'string' || !nameToTool.has(parsed.name)) {
            malformed++;
            continue;
        }
        const input = (parsed.arguments && typeof parsed.arguments === 'object') ? parsed.arguments : {};
        out.toolUses.push({ name: parsed.name, input });
    }
    if (malformed > 0) {
        out.warning = `[tool_parse_failed: ${malformed} block(s) rejected]`;
    }
    return out;
}

/**
 * Render a `tool_result` content block (from a previous user turn) as a
 * prompt segment for the next model invocation.
 *
 * @param {string} toolUseId - The Anthropic tool_use id (e.g. "toolu_abc").
 * @param {object|string} content - The tool result content (object or string).
 * @returns {string}
 */
export function renderToolResultForPrompt(toolUseId, content) {
    const body = typeof content === 'string' ? content : JSON.stringify(content ?? null);
    return `[Previous tool call result]\nTOOL_ID: ${toolUseId}\nRESULT: ${body}\n`;
}

/**
 * Render an assistant `tool_use` content block (from a previous assistant
 * turn) as a prompt segment for the next model invocation.
 *
 * @param {string} name - Tool name.
 * @param {object} input - Tool arguments.
 * @returns {string}
 */
export function renderAssistantToolUseForPrompt(name, input) {
    return `[I previously decided to call a tool]\n<tool_use>{"name":${JSON.stringify(name)},"arguments":${JSON.stringify(input ?? {})}}</tool_use>\n`;
}