/**
 * Local request and streaming protocol between the PI Desktop extension and ACP runtime.
 * These types describe runtime behavior, not a host SDK compatibility layer.
 * @module pi-antigravity-acp/protocol
 */
/** Brand an id without allocating or changing its wire representation. */
export function ToolCallId(value) {
    return value;
}
/** Runtime failure with a stable code and the original failure as its cause. */
export class LlmError extends Error {
    code;
    constructor(message, code, options) {
        super(message, options);
        this.code = code;
        this.name = 'LlmError';
    }
}
