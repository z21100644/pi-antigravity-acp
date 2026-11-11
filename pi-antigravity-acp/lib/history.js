/**
 * Projection of PI Desktop request history into Antigravity ACP prompts.
 *
 * ACP sessions own their history, so PI Desktop replays its authoritative history
 * once when a session is (re)built and afterwards sends only new input. The
 * replay renders earlier turns as a delimited transcript in front of the
 * newest user input; tool calls keep the agent-visible `mcp_pi_` names.
 * @module pi-antigravity-acp/history
 */
/** Server name under which PI Desktop tools reach the agent; the agent prefixes tool names with `mcp_<server>_`. */
export const MCP_SERVER_NAME = 'pi';
/** Agent-visible prefix of every PI Desktop tool. */
export const AGENT_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`;
/** Fallback MCP tool name for invoking any PI Desktop tool omitted from direct declarations. */
export const CALL_TOOL_NAME = 'pi_call_tool';
/**
 * Byte budget for the replayed history transcript while the context gates are
 * unlocked: about 730K tokens, inside the 1M window and the 983K checkpoint
 * budget, with room left for the system prompt, tool schemas, live input, and
 * multi-step tool output.
 */
export const UNLOCKED_REPLAY_BUDGET_BYTES = 2_200_000;
/**
 * Byte budget under an unpatched `agy`, kept below its `64,000 * 3 = 192,000`
 * byte single-`USER_INPUT` truncation limit so the agent never tail-truncates
 * a replay prompt.
 */
export const LOCKED_REPLAY_BUDGET_BYTES = 160_000;
const HISTORY_OPEN = '<pi_history>\n';
const HISTORY_CLOSE = '\n</pi_history>\n\n';
/** Upper bound of the omission notice, reserved before history is selected. */
const OMISSION_NOTICE_RESERVE_BYTES = 128;
/**
 * Live input for a rebuild whose trailing messages are all tool results (for
 * example right after compaction in the middle of a tool loop), so the agent
 * receives a meaningful instruction instead of an empty prompt.
 */
export const EMPTY_INPUT_CONTINUATION = 'Continue the task from the latest tool results above.';
const BACKGROUND_USER_SOURCES = new Set(['agent-instructions']);
function isBackgroundInputMessage(message) {
    return message.role === 'user' && message.source !== undefined && BACKGROUND_USER_SOURCES.has(message.source.kind);
}
function stripSystemReminderEnvelope(raw) {
    const trimmed = raw.trim();
    const match = /^<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>$/i.exec(trimmed);
    return match?.[1] !== undefined ? match[1].trim() : trimmed;
}
/**
 * Split native policy and explicitly sourced initial rules from history.
 * Later rules retain their original position and scope in the conversation.
 * @param options - the model request.
 * @returns the combined system text and the remaining messages.
 */
export function splitSystem(options) {
    const parts = [];
    if (options.system !== undefined && options.system.length > 0)
        parts.push(options.system);
    let index = 0;
    for (const message of options.messages) {
        if (message.role !== 'system')
            break;
        parts.push(textOf(message.content));
        index++;
    }
    const messages = options.messages.slice(index);
    // Older releases declared in-history system replacement to PI Desktop. Adopt its
    // latest complete policy, but never replay superseded policies into a fresh
    // ACP context. The adapter no longer advertises that capability.
    const latestSystem = messages.findLast(message => message.role === 'system');
    if (latestSystem !== undefined) {
        parts.length = 0;
        if (options.system !== undefined && options.system.length > 0)
            parts.push(options.system);
        parts.push(textOf(latestSystem.content));
    }
    const rules = [];
    const remaining = [];
    let sawAssistant = false;
    for (const message of messages) {
        if (message.role === 'assistant')
            sawAssistant = true;
        if (message.role === 'system' && latestSystem !== undefined)
            continue;
        if (!sawAssistant && isBackgroundInputMessage(message)) {
            const cleaned = stripSystemReminderEnvelope(textOf(message.content));
            if (cleaned.length > 0)
                rules.push(cleaned);
            continue;
        }
        remaining.push(message);
    }
    if (rules.length > 0)
        parts.push(`<user_rules>\n${rules.join('\n\n')}\n</user_rules>`);
    return { system: parts.filter(Boolean).join('\n\n'), messages: remaining };
}
/**
 * Join the text blocks of one message.
 * @param content - message content blocks.
 * @returns concatenated text.
 */
export function textOf(content) {
    return content.filter((b) => b.type === 'text').map(b => b.text).join('');
}
/** Whether the host explicitly marked this message as a replaceable runtime snapshot. */
export function isRuntimeContextSnapshot(message) {
    if (message.role !== 'user' && message.role !== 'developer')
        return false;
    const source = message.source;
    return source?.kind === 'runtime-context' && source.form === 'snapshot'
        && Array.isArray(source.sections) && source.sections.every(section => section !== null && typeof section === 'object'
        && typeof section.name === 'string' && typeof section.text === 'string');
}
/**
 * The bridge instructions appended to the agent's system prompt.
 * @param system - the PI Desktop system prompt.
 * @returns the complete appended system text.
 */
export function bridgeSystemPrompt(system) {
    const preamble = [
        'You are the primary model of a PI Desktop session. The harness owns the conversation, the tools, and their permissions.',
        `Every harness tool is available to you under the prefix \`${AGENT_TOOL_PREFIX}\`: a tool named \`X\` in the instructions below is the tool \`${AGENT_TOOL_PREFIX}X\`. If \`${AGENT_TOOL_PREFIX}X\` is absent from your direct tool declarations, invoke it via \`${AGENT_TOOL_PREFIX}${CALL_TOOL_NAME}\` with \`{"name":"X","arguments":{...}}\`. Use only these tools; pass arguments exactly as their schemas define.`,
        'Every live MCP call must include toolSummary, a short task description required by agy. This transport field is separate from the PI Desktop tool arguments.',
        'When the first user message contains a <pi_history> block, it reproduces the earlier part of this conversation; continue from the newest input after it without repeating completed actions.',
    ].join('\n');
    return system.length > 0 ? `${preamble}\n\n${system}` : preamble;
}
/**
 * Render a list of messages as transcript text.
 * @param messages - earlier conversation messages.
 * @returns transcript lines.
 */
export function renderTranscript(messages) {
    const lines = [];
    for (const message of messages) {
        switch (message.role) {
            case 'user':
                lines.push(`<user>\n${renderBlocks(message.content)}\n</user>`);
                break;
            case 'assistant': {
                const text = renderBlocks(message.content.filter(b => b.type !== 'tool-call' && b.type !== 'reasoning'));
                if (text.length > 0)
                    lines.push(`<assistant>\n${text}\n</assistant>`);
                for (const block of message.content) {
                    if (block.type === 'tool-call') {
                        lines.push(`<tool_call id="${block.id}" name="${AGENT_TOOL_PREFIX}${block.name}">\n${block.arguments}\n</tool_call>`);
                    }
                }
                break;
            }
            case 'tool':
                lines.push(`<tool_result id="${message.toolCallId}"${message.isError === true ? ' error="true"' : ''}>\n${renderBlocks(message.content)}\n</tool_result>`);
                break;
            case 'developer': {
                const text = renderBlocks(message.content);
                if (text.length > 0)
                    lines.push(`<harness_notice>\n${text}\n</harness_notice>`);
                break;
            }
            case 'system':
                lines.push(`<system_update>\n${renderBlocks(message.content)}\n</system_update>`);
                break;
            default:
                break;
        }
    }
    return lines.join('\n\n');
}
function renderBlocks(content) {
    const parts = [];
    for (const block of content) {
        switch (block.type) {
            case 'text':
                parts.push(block.text);
                break;
            case 'image':
                parts.push(`[image ${block.attachment.attachmentId}${block.offloaded === true ? ' (offloaded)' : ''}]`);
                break;
            case 'file':
                parts.push(`[file ${block.attachment.attachmentId}]`);
                break;
            case 'tool-addition':
                parts.push(`[tool added: ${AGENT_TOOL_PREFIX}${block.toolName}]`);
                break;
            case 'tool-removal':
                parts.push(`[tool removed: ${AGENT_TOOL_PREFIX}${block.toolName}]`);
                break;
            default:
                break;
        }
    }
    return parts.join('\n');
}
/**
 * Convert one user-role message into ACP prompt blocks, inlining images concurrently.
 * @param content - user content blocks.
 * @param resolveImage - image byte resolver.
 * @returns prompt blocks in content order.
 */
export async function promptBlocks(content, resolveImage) {
    const parts = await Promise.all(content.map(async (block) => {
        if (block.type === 'text') {
            return block.text.length > 0 ? [{ type: 'text', text: block.text }] : [];
        }
        if (block.type === 'image' && block.offloaded !== true) {
            const image = await resolveImage(block);
            return image !== undefined
                ? [{ type: 'image', data: image.data, mimeType: image.mimeType }]
                : [{ type: 'text', text: `[image ${block.attachment.attachmentId} unavailable]` }];
        }
        const text = renderBlocks([block]);
        return text.length > 0 ? [{ type: 'text', text }] : [];
    }));
    return parts.flat();
}
/**
 * Build the prompt that (re)creates a session: earlier history as transcript,
 * then the trailing input messages as live content.
 *
 * The trailing input is always complete. History renders newest-first into the
 * remaining byte budget, so the most recent turns survive and only the oldest
 * messages are omitted; an omitted prefix is announced inside the block. The
 * `<pi_history>` block is always closed before the live input. When the plan
 * leaves no trailing input (the history ends with tool results), a short
 * continuation instruction is appended so the prompt is never empty.
 * @param history - messages before the trailing input.
 * @param input - trailing input messages sent as live content.
 * @param resolveImage - image byte resolver.
 * @param maxHistoryBytes - combined history and input byte ceiling; defaults to {@link UNLOCKED_REPLAY_BUDGET_BYTES}.
 * @returns prompt blocks.
 */
export async function replayPrompt(history, input, resolveImage, maxHistoryBytes) {
    // A later host snapshot supersedes earlier snapshots from this producer.
    // Project only the rebuilt context; durable history and normal appends stay intact.
    const combined = [...history, ...input];
    const latestSnapshot = combined.findLastIndex(isRuntimeContextSnapshot);
    const replayHistory = history.filter((message, index) => !isRuntimeContextSnapshot(message) || index === latestSnapshot);
    const replayInput = input.filter((message, index) => !isRuntimeContextSnapshot(message) || history.length + index === latestSnapshot);
    const inputBlocks = replayInput.length > 0
        ? await inputPrompt(replayInput, resolveImage)
        : [{ type: 'text', text: EMPTY_INPUT_CONTINUATION }];
    const blocks = [];
    if (replayHistory.length > 0) {
        const maxBytes = maxHistoryBytes ?? UNLOCKED_REPLAY_BUDGET_BYTES;
        const inputBytes = inputBlocks.reduce((total, block) => total + (block.type === 'text' ? utf8Bytes(block.text) : 0), 0);
        const overhead = utf8Bytes(HISTORY_OPEN) + utf8Bytes(HISTORY_CLOSE) + OMISSION_NOTICE_RESERVE_BYTES;
        const text = historyTranscript(replayHistory, Math.max(0, maxBytes - inputBytes - overhead));
        if (text.length > 0)
            blocks.push({ type: 'text', text });
    }
    blocks.push(...inputBlocks);
    return blocks;
}
/**
 * Render the newest messages that fit `budget`, announcing any omitted prefix.
 * @param history - messages before the trailing input.
 * @param budget - byte budget for the transcript body.
 * @returns the complete `<pi_history>` block, or an empty string without history.
 */
function historyTranscript(history, budget) {
    const parts = [];
    let used = 0;
    let dropped = 0;
    for (let index = history.length - 1; index >= 0; index--) {
        const message = history[index];
        const rendered = renderTranscript([message]);
        const separator = parts.length === 0 ? 0 : 2;
        const bytes = utf8Bytes(rendered);
        if (used + separator + bytes > budget) {
            if (parts.length === 0 && message.role === 'tool' && budget > 1024) {
                const truncated = truncatedToolTranscript(message, budget);
                if (truncated !== undefined) {
                    parts.unshift(truncated);
                    dropped = index;
                }
                else {
                    dropped = index + 1;
                }
            }
            else {
                dropped = index + 1;
            }
            break;
        }
        parts.unshift(rendered);
        used += separator + bytes;
    }
    if (dropped > 0)
        parts.unshift(`[Earlier ${dropped} history messages omitted to fit the context replay budget]`);
    if (parts.length === 0)
        return '';
    return `${HISTORY_OPEN}${parts.join('\n\n')}${HISTORY_CLOSE}`;
}
/**
 * Render one oversized tool result with its head kept inside `budget`.
 * @param message - the newest tool message.
 * @param budget - byte budget for its rendered transcript.
 * @returns the truncated transcript, or undefined when even the markup does not fit.
 */
function truncatedToolTranscript(message, budget) {
    const marker = '\n[tool result truncated to fit the context replay budget]';
    let limit = budget - utf8Bytes(marker);
    for (let attempt = 0; attempt < 8 && limit > 0; attempt++) {
        const content = [{ type: 'text', text: `${headWithinBytes(renderBlocks(message.content), limit)}${marker}` }];
        const rendered = renderTranscript([{ ...message, content }]);
        const bytes = utf8Bytes(rendered);
        if (bytes <= budget)
            return rendered;
        limit -= bytes - budget;
    }
    return undefined;
}
function utf8Bytes(text) {
    return Buffer.byteLength(text, 'utf8');
}
function headWithinBytes(text, maxBytes) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maxBytes)
        return text;
    let end = Math.max(0, maxBytes);
    while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0)
        end--;
    return bytes.subarray(0, end).toString('utf8');
}
/**
 * Convert new input messages (user, developer notices) into live prompt blocks.
 * @param input - messages that arrived after the session's known history.
 * @param resolveImage - image byte resolver.
 * @returns prompt blocks.
 */
export async function inputPrompt(input, resolveImage) {
    const groups = await Promise.all(input.map(async (message) => {
        if (message.role === 'user')
            return promptBlocks(message.content, resolveImage);
        const text = renderTranscript([message]);
        return text.length > 0 ? [{ type: 'text', text }] : [];
    }));
    const blocks = [];
    for (const group of groups) {
        if (group.length === 0)
            continue;
        // agy concatenates adjacent text blocks verbatim. Separate messages, but
        // preserve text fragments within one message and the ordering of images.
        const previous = blocks.at(-1);
        if (previous?.type === 'text')
            previous.text += '\n\n';
        else if (previous !== undefined)
            blocks.push({ type: 'text', text: '\n\n' });
        for (const block of group) {
            const tail = blocks.at(-1);
            if (tail?.type === 'text' && block.type === 'text')
                tail.text += block.text;
            else
                blocks.push(block);
        }
    }
    if (blocks.length === 0)
        blocks.push({ type: 'text', text: 'Continue.' });
    return blocks;
}
