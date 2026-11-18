import { useAtomValue } from 'jotai';
import { coordinatedSessionIdsAtom, sessionCoordinatorIdAtom, sessionTitleAtom } from '../../store/atoms/sessions';

type OnOpenSession = (sessionId: string) => void;

function SessionLink({ sessionId, onOpen }: { sessionId: string; onOpen?: OnOpenSession }) {
  const title = useAtomValue(sessionTitleAtom(sessionId)) || sessionId;
  return (
    <a
      href={`nimbalyst://session/${encodeURIComponent(sessionId)}`}
      title={title}
      className="session-coordination-link min-w-0 truncate text-nim-accent underline"
      draggable={false}
      onClick={event => {
        event.stopPropagation();
        if (onOpen) {
          event.preventDefault();
          onOpen(sessionId);
        }
      }}
      onDoubleClick={event => event.stopPropagation()}
    >
      {title}
    </a>
  );
}

export function CoordinatorLink({ sessionId, onOpen }: { sessionId: string; onOpen?: OnOpenSession }) {
  const coordinatorId = useAtomValue(sessionCoordinatorIdAtom(sessionId));
  if (!coordinatorId) return null;
  return (
    <div className="session-coordinator flex min-w-0 items-baseline gap-1 text-xs text-nim-muted">
      <span className="shrink-0">Coordinated by</span>
      <SessionLink sessionId={coordinatorId} onOpen={onOpen} />
    </div>
  );
}

export function CoordinatedSessionsLinks({ sessionId, onOpen }: { sessionId: string; onOpen?: OnOpenSession }) {
  const sessionIds = useAtomValue(coordinatedSessionIdsAtom(sessionId));
  if (!sessionIds.length) return null;
  return (
    <div className="coordinated-sessions flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs text-nim-muted">
      <span className="shrink-0">Coordinates</span>
      <ul className="m-0 flex min-w-0 list-none flex-wrap gap-x-2 p-0">
        {sessionIds.map(id => (
          <li key={id} className="flex min-w-0">
            <SessionLink sessionId={id} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </div>
  );
}
