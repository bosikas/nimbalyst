import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

// Keep Vibe's normal ACP entry point and extend just its live session dispatch.
// The Python source is bundled with the same runtime that launches the child.
const steeringBridge = `
import inspect
from vibe.acp.entrypoint import main

try:
    from pydantic import TypeAdapter
    from vibe.acp import agent
    from vibe.acp.content import AcpContentBlock
    from vibe.app_server import protocol
    from vibe.app_server.session import AppServerSession
    compatible = (
        hasattr(agent.VibeAcpAgent, "_prepare_turn_input")
        and hasattr(AppServerSession, "active_turn_id")
        and "require_active_turn" in inspect.signature(
            AppServerSession.inject_user_context
        ).parameters
    )
    if compatible:
        prompt_adapter = TypeAdapter(list[AcpContentBlock])
except (ImportError, AttributeError, TypeError, ValueError):
    compatible = False

if compatible:
    class SteeringAgent(agent.VibeAcpAgent):
        async def ext_method(self, method, params):
            if method != "nimbalyst/steer":
                return await super().ext_method(method, params)

            session = self.sessions.get(params["sessionId"])
            if session is None or not session.app_server.active_turn_id:
                return {"accepted": False}
            turn_id = session.app_server.active_turn_id
            content = agent.project_prompt(prompt_adapter.validate_python(params["prompt"]))
            turn_input = await self._prepare_turn_input(
                session, content, message_id=params["messageId"], display=None
            )
            if session.app_server.active_turn_id != turn_id:
                return {"accepted": False}
            try:
                await session.app_server.inject_user_context(
                    turn_input.text,
                    as_message=True,
                    inject_invoked_skill=True,
                    images=turn_input.images,
                    resources=turn_input.resources,
                    client_message_id=turn_input.client_message_id,
                    mention_stats=turn_input.mention_stats,
                    require_active_turn=True,
                )
            except protocol.AppServerResponseError as exc:
                if exc.error.code == protocol.ProtocolErrorCode.CONFLICT:
                    return {"accepted": False}
                raise
            return {"accepted": True}

    agent.VibeAcpAgent = SteeringAgent

main()
`;

export function resolveVibeSteeringLaunch(command: string, args: string[]) {
  const original = { command, args };
  if (!isAbsolute(command) || args.length > 0) return original;

  try {
    const fd = openSync(command, constants.O_RDONLY | constants.O_NONBLOCK);
    let prefix: string;
    try {
      if (!fstatSync(fd).isFile()) return original;
      const bytes = Buffer.alloc(1024);
      prefix = bytes.toString('utf8', 0, readSync(fd, bytes));
    } finally {
      closeSync(fd);
    }

    const interpreter = /^#!([^\r\n]+)\r?\n/.exec(prefix)?.[1];
    if (!interpreter || !isAbsolute(interpreter) || !/^python(?:\d+(?:\.\d+)*)?$/.test(basename(interpreter))) return original;
    if (!prefix.includes('\nfrom vibe.acp.entrypoint import main\n')) return original;
    return { command: interpreter, args: ['-c', steeringBridge] };
  } catch {
    return original;
  }
}
