import { createGuidanceRenderer, type GuidanceRenderOptions } from '../../builtInGuidance';
import { instructionTemplate } from '../../instructionTemplates';
import { buildCodexMetadataSections } from '../../prompt';
import {
  areTrackerToolsEnabled,
  isInternalMcpServerEnabled,
  resolveTrackersWorkspacePath,
} from '../services/mcpServerConfig';
import type { DocumentContext } from '../types';

export interface CompactAgentSystemPromptOptions extends GuidanceRenderOptions {
  provider?: 'openai-codex' | 'openai-codex-acp' | 'mistral-vibe';
  documentContext?: DocumentContext;
  sessionDirective?: string;
  hasOutOfBandNaming: boolean;
  generateSummary?: boolean;
  hasSessionNaming?: boolean;
  startupSkills?: string[];
}

/** App guidance shared by native agents with their own repository and skill loading. */
export function buildCompactAgentSystemPrompt(options: CompactAgentSystemPromptOptions): string {
  const guidance = createGuidanceRenderer(options);
  const { documentContext, sessionDirective, startupSkills } = options;
  const isVibe = options.provider === 'mistral-vibe';
  const sections = [
    guidance('identity', instructionTemplate('codex.identity')),
    guidance('interactive-input', instructionTemplate('codex.interactive-input', [
      instructionTemplate(isVibe ? 'vibe.interactive-input-continuation' : 'codex.interactive-input-continuation'),
    ])),
    guidance('visual-communication', instructionTemplate('codex.visual-communication')),
    guidance('file-references', instructionTemplate('codex.file-references')),
    guidance('context-discovery', instructionTemplate('compact.context-discovery', [
      instructionTemplate(isVibe ? 'vibe.context-discovery' : 'codex.context-discovery'),
    ])),
    guidance('git-commits', instructionTemplate('codex.git-commits')),
  ];

  if (isVibe) sections.push(instructionTemplate('vibe.edit-recovery'));

  if (startupSkills) {
    if (isVibe) {
      if (startupSkills.length) sections.push(`Review skills: ${startupSkills.join(', ')}. Use skill.read to load them.`);
    } else {
      const skills = startupSkills.length ? 'Review skills: ' + startupSkills.join(', ') + '. ' : '';
      sections.push(skills + 'Use search_codex_skills on nimbalyst-host to find other skills when needed.');
    }
  }
  if (areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext))) {
    sections.push(guidance('trackers', instructionTemplate('codex.trackers')));
  }
  if (documentContext?.worktreePath) {
    sections.push(guidance('worktree', instructionTemplate('codex.worktree', [documentContext.worktreePath])));
  }
  if (options.hasSessionNaming ?? isInternalMcpServerEnabled()) {
    sections.push(...buildCodexMetadataSections(guidance, options.hasOutOfBandNaming, options.generateSummary));
  }
  const voiceContext = documentContext as DocumentContext & {
    isVoiceMode?: boolean;
    voiceModeCodingAgentPrompt?: { prepend?: string; append?: string };
  };
  if (voiceContext?.isVoiceMode) {
    const voice = voiceContext.voiceModeCodingAgentPrompt;
    if (voice?.prepend) sections.push(voice.prepend);
    sections.push(guidance('voice-mode', instructionTemplate('codex.voice-mode')));
    if (voice?.append) sections.push(voice.append);
  }
  if (sessionDirective?.trim()) sections.push(sessionDirective.trim());
  const body = sections.filter(Boolean).join('\n\n');
  return body ? instructionTemplate(isVibe ? 'vibe.addendum' : 'codex.addendum', [body]) : '';
}
