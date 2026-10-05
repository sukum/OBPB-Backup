import { DeviceState } from '../types/state';
import type { StateFileReaderWriter } from './types';
import { generateUUID } from '../utils/uuid';
import { parseDeviceState } from './state-validation';

/**
 * Manages static installation and vault identity stored at local_data/device.json.
 */
export class DeviceManager {
    private static readonly FILE_NAME = 'device.json';
    private deviceState: DeviceState | null = null;

    constructor(private storage: StateFileReaderWriter) {}

    /**
     * Loads or initializes device.json (machine and vault identity).
     * If device.json exists, it is the authoritative source of truth.
     * If missing, creates it using fallbackVaultId (if provided) or generates a new UUID.
     * Since we are saving it in a local file, it won't be exported to other obsidian devices using the same vault
     * This ensures that each device maintains its own unique identity even if multiple devices share the same vault.
     * Since the vault is stored in plugin settings, it gets shared with vault to different devices.
     * So multiple devices with same vault - same vault id, different device id
     */
    public async initialize(fallbackVaultId?: string): Promise<DeviceState> {
        if (this.deviceState) {
            return this.deviceState;
        }

        const raw = await this.storage.read(DeviceManager.FILE_NAME);
        if (raw) {
            try {
                const parsed = parseDeviceState(raw);
                if (parsed?.device && parsed?.vault) {
                    this.deviceState = parsed;
                    return parsed;
                }
            } catch (err) {
                console.error('[PB Backup] Corrupt device.json; regenerating:', err);
            }
        }

        this.deviceState = {
            device: generateUUID(),
            vault: fallbackVaultId && fallbackVaultId.trim() !== '' ? fallbackVaultId : generateUUID(),
        };

        await this.storage.write(DeviceManager.FILE_NAME, JSON.stringify(this.deviceState, null, 2));
        return this.deviceState;
    }

    public getDevice(): string {
        if (!this.deviceState) throw new Error('DeviceManager not initialized');
        return this.deviceState.device;
    }

    public getVaultId(): string {
        if (!this.deviceState) throw new Error('DeviceManager not initialized');
        return this.deviceState.vault;
    }
}
