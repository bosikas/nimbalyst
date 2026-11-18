#!/usr/bin/env python3
"""PreToolUse guard for repository inspection. Never executes the proposed command.

This bounds recognized text reads and search previews, not arbitrary programs.
Large analysis belongs in context-mode, where only printed answers are returned.
"""
import json
import re
import shlex
import sys
from pathlib import Path

MAX_LINES = 20
MAX_BYTES = 8192
INSTRUCTIONS = {"AGENTS.md", "CLAUDE.md", "SKILL.md"}
READERS = {"cat", "sed", "head", "tail", "rg", "grep", "find", "awk"}
REASON = (
    "Repository context budget: inspection exceeds 20 lines or 8192 bytes, "
    "or its output is unbounded. Use mcp__context_mode__ctx_execute/ctx_batch "
    "and print only the answer; use ctx_index + ctx_search for repeated queries. "
    "Each pipeline and the combined call must fit; a later head does not bound earlier output."
)


def words(stage):
    stage = list(stage)
    while stage and (stage[0] in {"command", "env"} or re.fullmatch(r"\w+=.*", stage[0])):
        stage.pop(0)
    if stage:
        stage[0] = Path(stage[0]).name
    return stage


def pipelines(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars="|;&()\n<>")
    lexer.whitespace = " \t\r"
    result, pipeline, stage = [], [], []
    for token in lexer:
        if token and all(c in "|;&()\n" for c in token):
            if stage:
                pipeline.append(words(stage))
                stage = []
            if token != "|" and pipeline:
                result.append(pipeline)
                pipeline = []
        else:
            stage.append(token)
    if stage:
        pipeline.append(words(stage))
    if pipeline:
        result.append(pipeline)
    return result


def preview(stage):
    """Only a terminal head bounds a pipeline; negative/tail ranges do not."""
    if not stage or stage[0] != "head":
        return None
    if len(stage) == 1:
        return 10
    text = " ".join(stage[1:])
    match = re.fullmatch(r"(?:-n\s*|--lines[= ])(\d+)", text)
    match = match or re.fullmatch(r"-(\d+)", text)
    return int(match.group(1)) if match else None


def redirects_stdout(stage):
    return any(token in {">", ">>", "&>"} and
               (index == 0 or not stage[index - 1].isdigit() or stage[index - 1] == "1")
               for index, token in enumerate(stage))


def without_redirections(stage):
    result = []
    skip = False
    for token in stage:
        if skip:
            skip = False
        elif token in {">", ">>", "<", "<<"}:
            if result and result[-1].isdigit():
                result.pop()
            skip = True
        else:
            result.append(token)
    return result


def read_size(paths, cwd, start=1, limit=None):
    lines = size = 0
    for raw in paths:
        if any(c in raw for c in "$`*?["):
            raise ValueError("dynamic file read")
        path = cwd / raw
        # A small instruction-only read must remain possible at session start.
        instruction = path.name in INSTRUCTIONS and len(paths) == 1 and limit is None
        if not path.is_file():
            raise ValueError("unknown file read")
        with path.open("rb") as source:
            # Bounded readline also handles a minified file containing one enormous line.
            for index in range(start - 1):
                if not source.readline(MAX_BYTES + 1):
                    break
            count = 0
            while limit is None or count < limit:
                line = source.readline(MAX_BYTES + 1)
                if not line:
                    break
                lines += 1
                count += 1
                size += len(line)
                if size > (65536 if instruction else MAX_BYTES) or (not instruction and lines > MAX_LINES):
                    raise ValueError("large file read")
        if instruction:
            lines = size = 0
    return lines, size


def inspect(command, cwd):
    lines = size = 0
    for pipeline in pipelines(command):
        # A later reader may ignore stdin and open a different file. It cannot
        # inherit a bound measured for the first command in the pipeline.
        readers = [index for index, stage in enumerate(pipeline)
                   if stage and (stage[0] in READERS or
                                 (stage[0] == "git" and stage[1:2] in [["diff"], ["show"], ["log"]]))]
        if readers:
            pipeline = pipeline[readers[0]:]
            if any(stage and stage[0] in READERS and preview(stage) is None for stage in pipeline[1:]):
                raise ValueError("multiple pipeline readers")
        first = without_redirections(pipeline[0])
        if not first:
            continue
        program, args = first[0], first[1:]
        if program == "cd" and len(args) == 1:
            cwd = cwd / args[0]
            continue
        if program in {"bash", "sh", "zsh"} and args[:1] == ["-c"] and len(args) == 2:
            added_lines, added_size = inspect(args[1], cwd)
        elif program not in READERS and not (program == "git" and args[:1] in [["diff"], ["show"], ["log"]]):
            continue
        elif redirects_stdout(pipeline[-1]):
            # Redirected writes produce no inspection stdout. Do not rewrite edits.
            continue
        else:
            limit = preview(pipeline[-1]) if len(pipeline) > 1 else None
            if limit is not None and limit > MAX_LINES:
                raise ValueError("large preview")
            if program == "cat":
                paths = [arg for arg in args if not arg.startswith("-")]
                if not paths:
                    raise ValueError("unbounded stdin")
                added_lines, added_size = read_size(paths, cwd, limit=limit)
            elif program == "sed" and len(args) >= 3 and args[0] == "-n":
                match = re.fullmatch(r"(\d+)(?:,(\d+))?p", args[1])
                if not match:
                    raise ValueError("unsupported sed read")
                start = int(match.group(1))
                count = int(match.group(2) or start) - start + 1
                if start < 1 or count < 0 or count > MAX_LINES:
                    raise ValueError("large sed range")
                added_lines, added_size = read_size(args[2:], cwd, start, min(count, limit) if limit is not None else count)
            elif program in {"head", "tail"} and len(args) >= 3 and args[0] == "-n" and args[1].isdigit():
                count = int(args[1])
                if count > MAX_LINES or program == "tail":
                    raise ValueError("use a focused head or sed read")
                added_lines, added_size = read_size(args[2:], cwd, limit=count)
            elif program == "git" and args[:1] == ["log"] and "--oneline" in args:
                count = next((int(arg[1:]) for arg in args if re.fullmatch(r"-\d+", arg)), None)
                if count is None or count > MAX_LINES:
                    raise ValueError("unbounded git log")
                added_lines, added_size = count, 0
            elif limit is not None:
                # Search output isn't executed here. Reserve its entire preview allowance.
                added_lines, added_size = limit, 0
            else:
                raise ValueError("unbounded inspection")
        lines += added_lines
        size += added_size
        if lines > MAX_LINES or size > MAX_BYTES:
            raise ValueError("combined output exceeds budget")
    return lines, size


def main():
    try:
        payload = json.load(sys.stdin)
        tool = payload.get("tool_name", "")
        data = payload.get("tool_input", {})
        cwd = Path(payload.get("cwd") or ".")
        if tool in {"Bash", "exec_command"}:
            inspect(data.get("command") or data.get("cmd") or "", cwd)
        elif tool == "Read":
            path = data.get("file_path", "")
            if Path(path).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"}:
                limit = data.get("limit")
                if limit is not None and (not isinstance(limit, int) or limit < 1 or limit > MAX_LINES):
                    raise ValueError("large Read limit")
                read_size([path], cwd, max(1, int(data.get("offset", 1))), limit)
    except (ValueError, TypeError, OSError, AttributeError):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny",
            "permissionDecisionReason": REASON,
        }}))


if __name__ == "__main__":
    main()
