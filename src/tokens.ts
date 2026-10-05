import type PBBackupPlugin from './main';
import type { PBBackupSettings } from './types/settings';
import { InjectionToken } from './container';

export const PLUGIN_TOKEN = new InjectionToken<PBBackupPlugin>('Plugin');
export const PLUGIN_DIR_TOKEN = new InjectionToken<string>('PluginDir');
export const SETTINGS_TOKEN = new InjectionToken<PBBackupSettings>('Settings');
