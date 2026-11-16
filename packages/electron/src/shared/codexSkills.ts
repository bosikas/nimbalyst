export interface CodexSkillEntry {
  name: string;
  path: string;
  description: string;
  scope: string;
  enabled: boolean;
  pluginId?: string | null;
}
export interface CodexSkillCatalog {
  skills: CodexSkillEntry[];
  errors: Array<{ path: string; message: string }>;
}
