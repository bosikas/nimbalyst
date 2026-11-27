export interface PreparedContextRequest {
  measuredAt: number;
  scope: string;
  categories: Array<{ name: string; bytes: number; reason: string }>;
  configuredMcpServers: number;
  attachments: number;
  nativeContext: string;
}
