/** The upstream stream could not be reconstructed into executable tool calls. */
export class ToolCallProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolCallProtocolError';
  }
}
