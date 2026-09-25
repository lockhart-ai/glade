/** The Settings modal's sections, in the order its nav lists them (`docs/design/html/21-settings.html`). */
export enum SettingsSection {
  General = 'general',
  Agent = 'agent',
  Notifications = 'notifications',
  Appearance = 'appearance',
  Keyboard = 'keyboard',
  Plugins = 'plugins',
  /** Whether other agents may drive Glade, and how to connect them (`docs/control-api.md`). */
  Control = 'control',
  /** The workspace you're in: listed under its own heading, by the workspace's name. */
  Workspace = 'workspace',
}

/** A section about the whole app, rather than the workspace you are in. */
export type AppSection = Exclude<SettingsSection, SettingsSection.Workspace>

/** The app-wide sections, above the Workspace heading. */
export const APP_SECTIONS: readonly AppSection[] = [
  SettingsSection.General,
  SettingsSection.Agent,
  SettingsSection.Notifications,
  SettingsSection.Appearance,
  SettingsSection.Keyboard,
  SettingsSection.Plugins,
  SettingsSection.Control,
]

/** Each app-wide section's name, as the nav and its heading show it. */
export const SECTION_TITLES: Readonly<Record<AppSection, string>> = {
  [SettingsSection.General]: 'General',
  [SettingsSection.Agent]: 'Agent',
  [SettingsSection.Notifications]: 'Notifications',
  [SettingsSection.Appearance]: 'Appearance',
  [SettingsSection.Keyboard]: 'Keyboard',
  [SettingsSection.Plugins]: 'Plugins',
  [SettingsSection.Control]: 'Control',
}

/** Where ⌘, opens Settings: the Agent section, the one with the settings you change most. */
export const DEFAULT_SETTINGS_SECTION = SettingsSection.Agent
