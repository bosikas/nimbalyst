import { STRUCTURED_INPUT_FIELD_TYPES } from "@nimbalyst/collab-protocol";

const ASKS_USER_ONLY = { readOnlyHint: true } as const;

export function getInteractiveToolSchemas(sessionId: string | undefined) {
  if (!sessionId) return [];

  return [
    requestUserInputSchema(),
    {
      name: "AskUserQuestion",
      annotations: ASKS_USER_ONLY,
      description:
        "Ask multiple-choice questions and wait for answers; use for confirmation or disambiguation.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            description:
              "Questions to ask; each should offer 2-3 options.",
            items: {
              type: "object",
              properties: {
                header: {
                  type: "string",
                  description:
                    "Short label shown above the question (12 chars or fewer)",
                },
                question: {
                  type: "string",
                  description: "The question to show the user",
                },
                options: {
                  type: "array",
                  minItems: 2,
                  items: {
                    type: "object",
                    properties: {
                      label: {
                        type: "string",
                        description: "User-facing option label",
                      },
                      description: {
                        type: "string",
                        description: "Short sentence describing this option",
                      },
                    },
                    required: ["label", "description"],
                  },
                },
                multiSelect: {
                  type: "boolean",
                  description:
                    "Whether multiple options can be selected for this question",
                },
              },
              required: ["header", "question", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    {
      name: "developer_git_commit_proposal",
      description: `Propose an atomic Git commit for user review in a widget.
First call get_session_edited_files and cross-check git status. Include ALL session-edited files with uncommitted changes, not a subset.
Directory paths expand modified, deleted and non-ignored untracked files. Other sessions' exclusive edits start unchecked; shared edits stay checked. excludePaths removes literal files/subfolders. Reject ignored/empty directories, nested repos and expansions over 2000 files.
ONE REPOSITORY PER CALL; use separate proposals per repository. Relative paths use the session checkout/worktree; attached-repo paths stay absolute. Other roots are rejected. For another worktree from git worktree list, set absolute workingDirectory; all files must be there and approval is always manual.
Commit message: feat:/fix:/refactor:/docs:/test:/chore: prefix, one user-visible outcome in the title, explain impact/why, lines under 72 chars, no emojis. Dash bullets only for distinct changes. Include canonical issue-closing reference on its own line, or a neutral reference if syntax is unclear.`,
      inputSchema: {
        type: "object",
        properties: {
          filesToStage: {
            type: "array",
            items: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    path: {
                      type: "string",
                      description:
                        "File path, either relative to the session checkout (its worktree when linked) or absolute. Files in an attached folder are supplied to you as absolute paths; pass them back unchanged.",
                    },
                    status: {
                      type: "string",
                      enum: ["added", "modified", "deleted"],
                      description: "Git status of the file",
                    },
                  },
                  required: ["path", "status"],
                },
              ],
            },
            description:
              "Array of file or directory paths (strings) or file objects with path and status (added/modified/deleted). A directory expands to the changed, non-ignored files under it.",
          },
          excludePaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional. Literal files or directory prefixes (relative to the session checkout, or absolute) to leave out after directories are expanded. No globs.",
          },
          commitMessage: {
            type: "string",
            description:
              "Proposed commit message following the guidelines above",
          },
          reasoning: {
            type: "string",
            description:
              "Explanation of why these files were selected and why this commit message is appropriate",
          },
          workingDirectory: {
            type: "string",
            description:
              "Optional. Absolute path of another worktree of this session's repository (as listed by `git worktree list`) to commit into. Omit to commit in the session checkout.",
          },
        },
        required: ["filesToStage", "commitMessage", "reasoning"],
      },
    },
  ];
}

const REQUEST_USER_INPUT_FIELD_SCHEMA = {
  type: "object",
  description:
    "One field in a structured prompt. The `type` discriminator determines which other properties apply. Required-by-type:\n" +
    "  - multiSelect: items[]; optional minSelected, maxSelected\n" +
    "  - singleSelect: options[]; optional allowOther\n" +
    "  - reorder: items[]; optional minItems\n" +
    "  - editText: initialText; optional format ('markdown'|'plain'), placeholder, minLength, maxLength\n" +
    "  - confirm: optional defaultValue (boolean); omit it to make the user pick yes or no before they can submit",
  properties: {
    type: {
      type: "string",
      enum: [...STRUCTURED_INPUT_FIELD_TYPES],
      description: "Field type discriminator.",
    },
    id: {
      type: "string",
      description: "Key for this field's answer in the response payload.",
    },
    label: { type: "string", description: "Short label shown above the control." },
    description: { type: "string", description: "Optional longer explanation." },

    // multiSelect / reorder share `items`. multiSelect items use defaultChecked
    // and badge; reorder items use removable. Extra properties on the wrong
    // field type are ignored.
    items: {
      type: "array",
      description:
        "For multiSelect and reorder fields. multiSelect items: { id, title, subtitle?, badge?, defaultChecked? }. reorder items: { id, title, subtitle?, removable? }.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          subtitle: { type: "string" },
          badge: { type: "string", description: "multiSelect only: short badge label." },
          defaultChecked: { type: "boolean", description: "multiSelect only: pre-check this item." },
          removable: { type: "boolean", description: "reorder only: show a delete affordance for this item." },
        },
        required: ["id", "title"],
      },
    },

    // multiSelect bounds.
    minSelected: { type: "integer", minimum: 0, description: "multiSelect: floor on selections (default 0)." },
    maxSelected: { type: "integer", minimum: 0, description: "multiSelect: ceiling (default = items.length)." },

    // reorder bound.
    minItems: { type: "integer", minimum: 0, description: "reorder: floor when items have removable: true (default 0)." },

    // singleSelect.
    options: {
      type: "array",
      description: "For singleSelect: array of { id, label, description? }.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
        },
        required: ["id", "label"],
      },
    },
    allowOther: { type: "boolean", description: "singleSelect: show an 'Other' textarea fallback." },

    // editText.
    initialText: { type: "string", description: "editText: the seed text the user will edit." },
    format: {
      type: "string",
      enum: ["markdown", "plain"],
      description: "editText: how to interpret initialText and serialize the answer (default 'markdown').",
    },
    placeholder: { type: "string", description: "editText: placeholder text when empty." },
    minLength: { type: "integer", minimum: 0, description: "editText: minimum length to allow submit." },
    maxLength: { type: "integer", minimum: 1, description: "editText: maximum length." },

    // confirm.
    defaultValue: {
      type: "boolean",
      description:
        "confirm: pre-select yes or no. Omitted means unanswered -- submit stays blocked until the user picks, so an untouched field can never be read as a deliberate no.",
    },
  },
  required: ["type", "id", "label"],
};

function requestUserInputSchema() {
  return {
    // NOTE: Do NOT rename to anything that snake_cases to `request_user_input` --
    // that collides with a Codex CLI built-in tool gated to Plan mode and the
    // agent gets refused with "request_user_input is unavailable in Default mode".
    name: "PromptForUserInput",
    annotations: ASKS_USER_ONLY,
    description: `Ask for structured input; answers are keyed by field id. fields must be an ARRAY OF OBJECTS ({type,id,label,...}), never strings; required-by-type properties are below. Use multiSelect, singleSelect, reorder, editText or confirm for richer input than AskUserQuestion.`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Overall prompt title" },
        intro: { type: "string", description: "1-2 sentences of context above the fields" },
        fields: {
          type: "array",
          minItems: 1,
          items: REQUEST_USER_INPUT_FIELD_SCHEMA,
        },
        submitLabel: { type: "string", description: 'Submit button label (default "Confirm")' },
        cancelLabel: { type: "string", description: 'Cancel button label (default "Cancel")' },
      },
      required: ["fields"],
    },
  };
}

