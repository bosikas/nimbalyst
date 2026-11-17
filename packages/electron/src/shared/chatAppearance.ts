import { z } from 'zod';

/** Device-local presentation only; never changes the provider's context. */
export const ChatAppearanceSchema = z.object({
  textSize: z.number().min(12).max(20).default(14),
  readingWidth: z.number().int().min(560).max(1100).default(760),
  groupToolActivity: z.boolean().default(true),
});
export type ChatAppearance = z.infer<typeof ChatAppearanceSchema>;
export const DEFAULT_CHAT_APPEARANCE = ChatAppearanceSchema.parse({});
