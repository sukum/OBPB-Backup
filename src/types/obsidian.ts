import { TFile, TAbstractFile } from "obsidian";

export interface VaultReader {
    read: (file: TFile) => Promise<string>;
    cachedRead: (file: TFile) => Promise<string>;
    getAbstractFileByPath: (file: string) => TAbstractFile | null;
}
