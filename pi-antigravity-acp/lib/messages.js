import { createHash } from 'node:crypto';
function blocks(content) {
    if (typeof content === 'string')
        return [{ type: 'text', text: content }];
    return content.flatMap((block, index) => {
        switch (block.type) {
            case 'text': return [{ type: 'text', text: block.text }];
            case 'thinking': return [{ type: 'reasoning', text: block.thinking }];
            case 'redactedThinking': return [];
            case 'toolCall': return [{ type: 'tool-call', id: block.id, name: block.name, arguments: JSON.stringify(block.arguments) }];
            case 'image': return [{ type: 'image', attachment: { attachmentId: `image-${index}`, data: block.data, mimeType: block.mimeType } }];
            default: return [{ type: 'text', text: JSON.stringify(block) }];
        }
    });
}
/** Content-addressed ids detect in-place pruning as well as branch/compaction rewrites. */
function requestMessage(message) {
    const content = blocks(message.content);
    let projected;
    switch (message.role) {
        case 'assistant':
            projected = { role: 'assistant', content, source: { kind: 'model', provider: message.provider, model: message.model } };
            break;
        case 'toolResult':
            projected = { role: 'tool', content, toolCallId: message.toolCallId, isError: message.isError };
            break;
        default:
            projected = { role: message.role, content };
            // Preserve explicit producer metadata; reminder text alone is not a rule.
            if (message.role === 'user'
                && message.source?.kind === 'agent-instructions') {
                projected.source = { kind: 'agent-instructions' };
            }
    }
    projected.id = createHash('sha256').update(JSON.stringify(projected)).digest('hex');
    return projected;
}
export function toMessages(messages) {
    return messages.map(requestMessage);
}
