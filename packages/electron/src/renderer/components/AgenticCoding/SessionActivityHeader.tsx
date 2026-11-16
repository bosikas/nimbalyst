import React from 'react';
import { useAtomValue } from 'jotai';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { SESSION_ACTIVITY_APPEARANCE, type SessionListAppearance } from '../../../shared/sessionListAppearance';

export function SessionActivityHeader({ title, count }: { title: string; count: number }) {
  const appearance = useAtomValue(settingAtom('ui.sessionListAppearance'));
  return <ActivityHeading title={title} count={count} appearance={appearance} />;
}

export function ActivityHeading({ title, count, appearance }: { title: string; count: number; appearance: SessionListAppearance }) {
  const activity = SESSION_ACTIVITY_APPEARANCE[title as keyof typeof SESSION_ACTIVITY_APPEARANCE];
  const chosen = activity && appearance[activity.key];
  return <div className="session-activity-header" role="heading" aria-level={3}
    style={{ fontSize: appearance.headingSize, fontWeight: appearance.headingBold ? 650 : 500, color: chosen && chosen !== 'theme' ? chosen : activity?.color }}
    title={title === 'Idle' ? 'Nothing executing. Idle does not mean the task is complete.' : title === 'Needs you' ? 'A question or permission prompt is waiting for your response.' : 'A session is executing or has queued work.'}>
    <span className="session-activity-label">{activity && <MaterialSymbol icon={activity.icon} size={14} aria-hidden="true" />}<span>{title}</span></span><span className="session-activity-count">{count}</span>
  </div>;
}
