export const BACKUP_OPERATIONS = [
    'save',
    'rename',
    'delete',
 ] as const;
// export type BackupOperation = 'save' | 'rename' | 'delete';
export type BackupOperation = (typeof BACKUP_OPERATIONS)[number];
export const BACKUP_OPERATIONS_UPPER = [
    'SAVE',
    'RENAME',
    'DELETE',
] as const satisfies readonly Uppercase<BackupOperation>[];
export type BackupOperationUpper = (typeof BACKUP_OPERATIONS_UPPER)[number];

// export type BackupOperationUpper = Uppercase<BackupOperation>;

export const OBSIDIAN_VAULT_EVENTS = [
    'modify',
    'rename',
    'delete',
] as const;

export const BATCH_BACKUP_EVENTS = [
    'vault-backup',
    'vault-sync',
] as const;

export const BACKUP_EVENTS = [
    ...OBSIDIAN_VAULT_EVENTS,
    ...BATCH_BACKUP_EVENTS,
    'recovery',
] as const;
// export type BackupEventType = 'modify' | 'rename' | 'delete' | 'manual' | 'recovery';
export type BackupEventType = (typeof BACKUP_EVENTS)[number];
export type BatchBackupEventType = (typeof BATCH_BACKUP_EVENTS)[number];
export type ObsidianBackupEventType = (typeof OBSIDIAN_VAULT_EVENTS)[number];

export const BACKUP_OBJECT_TYPES = [
    'snapshot',
    'diff',
] as const;
// export type BackupObjectType = 'snapshot' | 'diff';
export type BackupObjectType = (typeof BACKUP_OBJECT_TYPES)[number];

export const BACKUP_MODES = [
    'auto',
    'snapshot',
    'diff',
] as const;
// export type BackupMode = 'auto' | 'snapshot' | 'diff';
export type BackupMode = (typeof BACKUP_MODES)[number];
