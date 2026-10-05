import { getRequestUrlOverride } from './request-url-hook';

export class TFile {
    path: string = '';
    name: string = '';
    extension: string = '';
    stat: any = {};
    basename: string = '';
    vault: any = null;
    parent: any = null;
}

export class TFolder {
    path: string = '';
    name: string = '';
    children: any[] = [];
    isRoot(): boolean { return false; }
}

export class TAbstractFile {
    path: string = '';
    name: string = '';
    parent: any = null;
    vault: any = null;
}

export class Notice {
    public static messages: string[] = [];

    constructor(public message: string, public timeout?: number) {
        Notice.messages.push(message);
    }

    public static clear(): void {
        Notice.messages = [];
    }
}

export class App {
    vault: any = {};
    workspace: any = {};
}

export class Modal {
    constructor(public app: any) {}
    open(): void {}
    close(): void {}
}

export class PluginSettingTab {
    constructor(public app: any, public plugin: any) {}
    display(): void {}
}

export class Setting {
    constructor(public containerEl: any) {}
    setName(name: string): this { return this; }
    setDesc(desc: string): this { return this; }
    addText(cb: any): this { return this; }
    addToggle(cb: any): this { return this; }
    addDropdown(cb: any): this { return this; }
    addButton(cb: any): this { return this; }
    addSlider(cb: any): this { return this; }
    addExtraButton(cb: any): this { return this; }
}

export class ItemView {
    constructor(public leaf: any) {}
    getViewType(): string { return ''; }
    getDisplayText(): string { return ''; }
}

export class WorkspaceLeaf {}

export class MarkdownRenderer {}
export class Component {}

export class MarkdownView {
    file: TFile | null = null;
    constructor(file?: TFile) {
        this.file = file ?? null;
    }
}

class MenuItem {
    title = '';
    icon = '';
    clickHandler: (() => unknown) | null = null;
    setTitle(title: string): this { this.title = title; return this; }
    setIcon(icon: string): this { this.icon = icon; return this; }
    onClick(callback: () => unknown): this { this.clickHandler = callback; return this; }
}

export class Menu {
    items: Array<MenuItem | 'separator'> = [];
    addItem(callback: (item: MenuItem) => unknown): this {
        const item = new MenuItem();
        callback(item);
        this.items.push(item);
        return this;
    }
    addSeparator(): this { this.items.push('separator'); return this; }
    showAtMouseEvent(event: MouseEvent): void { (this as any).shownAt = event; }
}

export class Plugin {
    app: any = new App();
    manifest: any = { id: 'test-plugin', dir: '.obsidian/plugins/test-plugin' };
    registerEvent(eventRef: any): void {}
    registerDomEvent(el: any, type: string, callback: any): void {}
    addCommand(command: any): void {}
    addSettingTab(tab: any): void {}
    registerView(type: string, viewCreator: any): void {}
    addStatusBarItem(): any { return {}; }
    addRibbonIcon(icon: string, title: string, callback: any): any { return {}; }
    async loadData(): Promise<any> { return {}; }
    async saveData(data: any): Promise<void> {}
}

export function setIcon(el: any, iconId: string): void {}

export interface Debouncer<T extends unknown[], V> {
    (...args: [...T]): this;
    cancel(): this;
    run(): V | void;
}

export function debounce<T extends unknown[], V>(
    cb: (...args: [...T]) => V,
    timeout = 0,
    resetTimer = false
): Debouncer<T, V> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: T | null = null;
    let lastThis: unknown = null;

    const debouncedFn = function (this: unknown, ...args: T) {
        lastArgs = args;
        lastThis = this;
        if (resetTimer && timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (!timer) {
            timer = setTimeout(() => {
                timer = null;
                if (lastArgs) {
                    cb.apply(lastThis, lastArgs);
                }
            }, timeout);
        }
        return debounced;
    };

    const debounced: Debouncer<T, V> = Object.assign(debouncedFn, {
        cancel: () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            return debounced;
        },
        run: () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
                if (lastArgs) {
                    return cb.apply(lastThis, lastArgs);
                }
            }
        },
    });

    return debounced;
}

export async function requestUrl(param: any): Promise<any> {
    const override = getRequestUrlOverride();
    if (override) {
        return override(param);
    }
    if (typeof fetch !== 'undefined' && param?.url) {
        const res = await fetch(param.url, {
            method: param.method || 'GET',
            headers: param.headers,
            body: param.body,
        });
        const text = await res.text();
        let json: any = null;
        try {
            json = JSON.parse(text);
        } catch {
            // Not JSON
        }
        const headersObj: Record<string, string> = {};
        res.headers.forEach((val, key) => {
            headersObj[key] = val;
        });
        return {
            status: res.status,
            headers: headersObj,
            text,
            json,
            arrayBuffer: null,
        };
    }
    return { status: 200, headers: {}, text: '', json: {} };
}

export function moment(input?: string | Date | number) {
    return {
        fromNow: () => {
            return String(input);
        },
    };
}
