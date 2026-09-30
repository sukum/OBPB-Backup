import type OBPBBackupPlugin from './main';
import type { OBPBBackupSettings } from './types/settings';
import { InjectionToken } from './container';

export const PLUGIN_TOKEN = new InjectionToken<OBPBBackupPlugin>('Plugin');
export const PLUGIN_DIR_TOKEN = new InjectionToken<string>('PluginDir');
export const SETTINGS_TOKEN = new InjectionToken<OBPBBackupSettings>('Settings');
