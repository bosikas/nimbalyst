/** Creation-only choices. Omission preserves native repository instructions. */
export interface SessionInstructionOptions {
  instructionFile?: string;
  nativeMultiAgent?: boolean;
  skipDefaultInstructions?: boolean;
}

export interface SessionInstructionSnapshot {
  path: string;
  content: string;
  sha256: string;
}
