import type { ContentBlock } from '@agentclientprotocol/sdk';
import { promises as fs } from 'fs';
import { buildDocumentAttachmentPromptText } from '../providers/codex/documentAttachmentPrompt';
import type { ProtocolMessage } from './ProtocolInterface';

export async function buildAcpAttachmentBlocks(attachments: ProtocolMessage['attachments']): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const attachment of attachments ?? []) {
    if (!attachment.filepath) continue;
    if (attachment.type === 'document') {
      blocks.push({ type: 'text', text: await buildDocumentAttachmentPromptText(attachment) });
    } else if (attachment.type === 'image') {
      const data = await fs.readFile(attachment.filepath);
      blocks.push({
        type: 'image',
        data: data.toString('base64'),
        mimeType: attachment.mimeType ?? 'application/octet-stream',
        uri: `file://${attachment.filepath}`,
      });
    }
  }
  return blocks;
}
