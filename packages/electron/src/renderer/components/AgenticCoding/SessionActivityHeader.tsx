import React from 'react';
import { useAtomValue } from 'jotai';
import { settingAtom } from '../../store/atoms/settingAtomFamily';

export function SessionActivityHeader({ title, count }: { title: string; count: number }) {
  const appearance = useAtomValue(settingAtom('ui.sessionListAppearance'));
  return <div className="session-activity-header" role="heading" aria-level={3}
    style={{ fontSize: appearance.headingSize, fontWeight: appearance.headingBold ? 650 : 500 }}
    title={title === 'Idle' ? 'Nothing executing. Idle does not mean the task is complete.' : title === 'Needs you' ? 'A prompt, blocker, decision or review needs attention.' : undefined}>
    <span>{title}</span><span className="session-activity-count">{count}</span>
  </div>;
}
