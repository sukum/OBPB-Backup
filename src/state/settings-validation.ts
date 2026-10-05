import type { PBBackupSettings } from '../types/settings';
import { isRecord } from '../utils/guards';
import { isFiniteNumber, isString } from './state-validation';
import { SETTINGS_STRING_KEYS, SETTINGS_NUMBER_KEYS } from '../types/settings';

/** Keeps only persisted settings whose values match the current settings contract. */
export function parsePersistedSettings(value: unknown): Partial<PBBackupSettings> {
    if (!isRecord(value)) return {};

    const settings: Partial<PBBackupSettings> = {};

    for (const key of SETTINGS_STRING_KEYS) {
        if (isString(value[key])) {
            settings[key] = value[key];
        }
    }

    for (const key of SETTINGS_NUMBER_KEYS) {
        if (isFiniteNumber(value[key])) {
            settings[key] = value[key];
        }
    }

    if (Array.isArray(value.monitoredExtensions)) {
        const extensions: unknown[] = value.monitoredExtensions;
        const stringExtensions = extensions.filter((extension): extension is string => typeof extension === 'string');
        if (stringExtensions.length === extensions.length) {
            settings.monitoredExtensions = stringExtensions;
        }
    }

    if (typeof value.safetyBackupBeforeRestore === 'boolean') {
        settings.safetyBackupBeforeRestore = value.safetyBackupBeforeRestore;
    }

    return settings;
}
