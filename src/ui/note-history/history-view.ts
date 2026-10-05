import { ItemView, WorkspaceLeaf, TFile, setIcon } from 'obsidian';
import type { BackupStore } from '../../remote/backup-store';
import type { FileHistorySummary } from '../../types/database';
import { PathUtils } from '../../utils/path-utils';
import { formatBytes } from '../../utils/format';
import { Hasher } from '../../hashing/hasher';

export const VIEW_TYPE_HISTORICAL_BACKUP = 'pb-backup-view';

/**
 * Sidebar ItemView displaying historical version timeline of the active note.
 */
export class HistoryView extends ItemView {
    private currentFilePath: string | null = null;
    private historyList: FileHistorySummary[] = [];
    private isLoading = false;

    constructor(
        leaf: WorkspaceLeaf,
        private getVaultId: () => string,
        private store: Pick<BackupStore, 'getHistory'>,
        private onSelectNoteVersion: (item: FileHistorySummary) => void
    ) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_HISTORICAL_BACKUP;
    }

    getDisplayText(): string {
        return 'Note history';
    }

    getIcon(): string {
        return 'history';
    }

    async onOpen(): Promise<void> {
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file instanceof TFile) {
                    void this.updateForFile(file.path);
                } else {
                    this.clearView('No active note selected.');
                }
            })
        );

        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            await this.updateForFile(activeFile.path);
        } else {
            this.clearView('No active note selected.');
        }
    }

    public async updateForFile(rawPath: string): Promise<void> {
        const normalized = PathUtils.normalize(rawPath);
        this.currentFilePath = normalized;
        this.isLoading = true;
        this.renderLoading();

        try {
            const vaultId = this.getVaultId();
            this.historyList = await this.store.getHistory(vaultId, normalized, 1, 50);
            this.isLoading = false;
            this.renderList();
        } catch (err) {
            this.isLoading = false;
            const msg = err instanceof Error ? err.message : String(err);
            this.clearView(`Failed to load history: ${msg}`);
        }
    }

    private clearView(message: string): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('pb_history_view');
        containerEl.createDiv({ cls: 'pb_empty', text: message });
    }

    private renderLoading(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('pb_history_view');
        containerEl.createDiv({ cls: 'pb_loading', text: 'Loading version history...' });
    }

    private renderList(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('pb_history_view');

        const header = containerEl.createDiv({ cls: 'pb_history_header' });
        header.createEl('h4', { text: this.currentFilePath?.split('/').pop() || 'Version history' });

        const refreshBtn = header.createEl('button', { cls: 'clickable-icon' });
        setIcon(refreshBtn, 'refresh-cw');
        refreshBtn.setAttribute('aria-label', 'Refresh version history');
        refreshBtn.addEventListener('click', () => {
            if (this.currentFilePath) {
                void this.updateForFile(this.currentFilePath);
            }
        });

        if (this.historyList.length === 0) {
            containerEl.createDiv({
                cls: 'pb_empty',
                text: 'No backups recorded yet for this note.',
            });
            return;
        }

        const listEl = containerEl.createDiv({ cls: 'pb_history_list' });

        for (const item of this.historyList) {
            const itemEl = listEl.createDiv({ cls: 'pb_history_item' });

            const topRow = itemEl.createDiv({ cls: 'pb_version_top' });
            // hash slice needs fixing
            topRow.createSpan({ cls: 'pb_version_hash', text: Hasher.hashStub8(item.hash) });
            topRow.createSpan({ cls: 'pb_version_time', text: new Date(item.timestamp).toLocaleString() });

            const bottomRow = itemEl.createDiv({ cls: 'pb_version_bottom' });
            bottomRow.createSpan({
                cls: `pb_badge pb_badge_${item.type}`,
                text: item.type.toUpperCase(),
            });
            bottomRow.createSpan({
                cls: 'pb_version_size',
                text: formatBytes(item.size),
            });
            bottomRow.createSpan({
                cls: 'pb_version_device',
                text: `Dev: ${item.device.slice(0, 6)}`,
            });

            itemEl.addEventListener('click', () => {
                this.onSelectNoteVersion(item);
            });
        }
    }
}
