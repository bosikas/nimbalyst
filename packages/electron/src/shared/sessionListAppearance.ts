import { z } from 'zod';

const ActivityColorSchema = z.union([z.literal('theme'), z.string().regex(/^#[0-9a-f]{6}$/i)]).default('theme');

export const SessionListAppearanceSchema = z.object({
  titleSize: z.number().min(11).max(22).default(13),
  childTitleSize: z.number().min(10).max(20).default(12),
  rowPadding: z.number().int().min(0).max(12).default(8),
  childPadding: z.number().int().min(0).max(10).default(5),
  summarySize: z.number().min(8).max(14).default(12),
  summaryLineHeight: z.number().min(10).max(22).default(18),
  scopeLines: z.number().int().min(1).max(3).default(2),
  headingSize: z.number().min(10).max(16).default(11),
  headingBold: z.boolean().default(false),
  runningColor: ActivityColorSchema,
  needsYouColor: ActivityColorSchema,
  idleColor: ActivityColorSchema,
  inactiveOpacity: z.number().min(0.4).max(1).default(1),
  showParentIcon: z.boolean().default(false),
  showChildIcon: z.boolean().default(false),
  showSummary: z.boolean().default(true),
  showRemaining: z.boolean().default(true),
  showModel: z.boolean().default(false),
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
export const COMPACT_SESSION_LIST_APPEARANCE: SessionListAppearance = { ...DEFAULT_SESSION_LIST_APPEARANCE, titleSize: 12, childTitleSize: 11.5, rowPadding: 4, childPadding: 3, scopeLines: 1, showModel: false };

export const SESSION_ACTIVITY_APPEARANCE = {
  Running: { key: 'runningColor', icon: 'play_arrow', color: 'var(--nim-success)' },
  'Needs you': { key: 'needsYouColor', icon: 'front_hand', color: 'var(--nim-warning)' },
  Idle: { key: 'idleColor', icon: 'pause', color: 'var(--nim-text-muted)' },
} as const;

export function sessionAppearanceVariables(s: SessionListAppearance): Record<string, string | number> {
  return {
    '--session-title-size': `${s.titleSize}px`, '--session-child-title-size': `${s.childTitleSize}px`,
    '--session-row-padding': `${s.rowPadding}px`, '--session-child-padding': `${s.childPadding}px`,
    '--session-summary-size': `${s.summarySize}px`, '--session-summary-leading': `${s.summaryLineHeight}px`,
    '--session-scope-lines': s.scopeLines, '--session-heading-size': `${s.headingSize}px`,
    '--session-heading-weight': s.headingBold ? 650 : 500, '--session-inactive-opacity': s.inactiveOpacity,
  };
}
