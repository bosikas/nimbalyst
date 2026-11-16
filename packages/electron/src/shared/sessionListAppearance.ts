import { z } from 'zod';

export const SessionListAppearanceSchema = z.object({
  titleSize: z.number().min(11).max(22).default(15),
  childTitleSize: z.number().min(10).max(20).default(13),
  rowPadding: z.number().int().min(0).max(12).default(6),
  childPadding: z.number().int().min(0).max(10).default(3),
  summarySize: z.number().min(8).max(14).default(9),
  summaryLineHeight: z.number().min(10).max(22).default(12),
  scopeLines: z.number().int().min(1).max(3).default(2),
  headingSize: z.number().min(10).max(16).default(12),
  headingBold: z.boolean().default(true),
  inactiveOpacity: z.number().min(0.4).max(1).default(0.7),
  showParentIcon: z.boolean().default(true),
  showChildIcon: z.boolean().default(false),
  showSummary: z.boolean().default(true),
  showRemaining: z.boolean().default(true),
  showModel: z.boolean().default(true),
  showTimestamps: z.boolean().default(true),
  childContext: z.enum(['hover', 'always', 'hidden']).default('hover'),
  branchGuides: z.boolean().default(true),
  indent: z.number().int().min(6).max(24).default(12),
  activeChildrenFirst: z.boolean().default(true),
  olderChildren: z.number().int().min(0).max(10).default(0),
  autoCollapseSeconds: z.number().int().min(0).max(600).default(60),
  hideRedundantWorktrees: z.boolean().default(true),
});
export type SessionListAppearance = z.infer<typeof SessionListAppearanceSchema>;
export const DEFAULT_SESSION_LIST_APPEARANCE = SessionListAppearanceSchema.parse({});
export const COMPACT_SESSION_LIST_APPEARANCE: SessionListAppearance = { ...DEFAULT_SESSION_LIST_APPEARANCE, titleSize: 14, childTitleSize: 12, rowPadding: 3, childPadding: 1, scopeLines: 1, showModel: false };

export function sessionAppearanceVariables(s: SessionListAppearance): Record<string, string | number> {
  return {
    '--session-title-size': `${s.titleSize}px`, '--session-child-title-size': `${s.childTitleSize}px`,
    '--session-row-padding': `${s.rowPadding}px`, '--session-child-padding': `${s.childPadding}px`,
    '--session-summary-size': `${s.summarySize}px`, '--session-summary-leading': `${s.summaryLineHeight}px`,
    '--session-scope-lines': s.scopeLines, '--session-heading-size': `${s.headingSize}px`,
    '--session-heading-weight': s.headingBold ? 650 : 500, '--session-inactive-opacity': s.inactiveOpacity,
  };
}
