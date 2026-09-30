import '../setup-dom';
import { getRequestUrlOverride } from '../../mocks/request-url-hook';

export class TFile {
    path: string = '';
    name: string = '';
    extension: string = '';
    stat: any = {};
    basename: string = '';
    vault: any = null;
    parent: any = null;

    constructor(path: string = '') {
        this.path = path;
        this.name = path.split('/').pop() || path;
        const dotIdx = this.name.lastIndexOf('.');
        this.basename = dotIdx >= 0 ? this.name.slice(0, dotIdx) : this.name;
        this.extension = dotIdx >= 0 ? this.name.slice(dotIdx + 1) : '';
    }
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
    public static notices: { message: string; timeout?: number }[] = [];
    public static get messages(): string[] {
        return Notice.notices.map(n => n.message);
    }
    constructor(public message: string, public timeout?: number) {
        Notice.notices.push({ message, timeout });
    }
    public static clear(): void {
        Notice.notices = [];
    }
}

export class App {
    vault: any = {
        read: async (file: TFile) => '',
        getAbstractFileByPath: (path: string) => null,
    };
    workspace: any;

    constructor() {
        const listeners: Record<string, ((...args: any[]) => any)[]> = {};
        this.workspace = {
            leaves: [] as WorkspaceLeaf[],
            activeFile: null as TFile | null,
            rootSplit: {},
            getLeavesOfType: (type: string) => {
                return this.workspace.leaves.filter((l: WorkspaceLeaf) => (l as any).viewType === type);
            },
            getLeaf: (type?: string) => {
                const leaf = new WorkspaceLeaf(this);
                this.workspace.leaves.push(leaf);
                return leaf;
            },
            getRightLeaf: (create?: boolean) => {
                const leaf = new WorkspaceLeaf(this);
                this.workspace.leaves.push(leaf);
                return leaf;
            },
            revealLeaf: (leaf: WorkspaceLeaf) => {
                (leaf as any).revealed = true;
            },
            getActiveFile: () => this.workspace.activeFile,
            openLinkText: async (path: string, source: string, newLeaf?: boolean) => {},
            getMostRecentLeaf: (rootSplit?: any) => {
                return this.workspace.leaves[this.workspace.leaves.length - 1] || null;
            },
            on: (event: string, callback: (...args: any[]) => any) => {
                listeners[event] ??= [];
                listeners[event].push(callback);
                return { event, callback };
            },
            trigger: (event: string, ...args: any[]) => {
                const handlers = listeners[event] || [];
                for (const h of handlers) h(...args);
            },
        };
    }
}

export class WorkspaceLeaf {
    app: App;
    view: any = null;
    viewState: any = null;
    revealed: boolean = false;

    constructor(app?: App) {
        this.app = app ?? new App();
    }

    async setViewState(state: any): Promise<void> {
        this.viewState = state;
        (this as any).viewType = state?.type;
    }
}

export class Component {
    load(): void {}
    unload(): void {}
}

export class MarkdownRenderer {
    static async render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
        el.createEl('pre', { text: markdown });
    }
}

export class ItemView {
    containerEl: HTMLElement;
    app: App;

    constructor(public leaf: WorkspaceLeaf) {
        this.containerEl = document.createElement('div');
        this.app = leaf?.app ?? new App();
    }

    getViewType(): string { return ''; }
    getDisplayText(): string { return ''; }
    getIcon(): string { return ''; }
    registerEvent(eventRef: any): void {}
}

export class Modal {
    contentEl: HTMLElement;
    title = '';

    constructor(public app: App) {
        this.contentEl = document.createElement('div');
    }

    setTitle(title: string): this {
        this.title = title;
        return this;
    }

    open(): void {
        (this as any).onOpen?.();
    }

    close(): void {
        (this as any).onClose?.();
    }
}

export class ButtonComponent {
    buttonEl: HTMLButtonElement;

    constructor(containerEl: HTMLElement) {
        this.buttonEl = containerEl.createEl('button');
    }

    setButtonText(text: string): this {
        this.buttonEl.setText(text);
        return this;
    }

    setCta(): this {
        this.buttonEl.addClass('mod-cta');
        return this;
    }

    removeCta(): this {
        this.buttonEl.removeClass('mod-cta');
        return this;
    }

    setWarning(): this {
        this.buttonEl.addClass('mod-warning');
        return this;
    }

    setDisabled(disabled: boolean): this {
        this.buttonEl.disabled = disabled;
        return this;
    }

    setIcon(icon: string): this {
        setIcon(this.buttonEl, icon);
        return this;
    }

    setTooltip(tooltip: string): this {
        this.buttonEl.setAttribute('aria-label', tooltip);
        return this;
    }

    onClick(cb: (evt: MouseEvent) => any): this {
        this.buttonEl.addEventListener('click', (e) => cb(e as MouseEvent));
        return this;
    }
}

export class TextComponent {
    inputEl: HTMLInputElement;

    constructor(containerEl: HTMLElement) {
        this.inputEl = containerEl.createEl('input', { type: 'text' });
    }

    setValue(val: string): this {
        this.inputEl.value = val;
        return this;
    }

    getValue(): string {
        return this.inputEl.value;
    }

    setPlaceholder(ph: string): this {
        this.inputEl.placeholder = ph;
        return this;
    }

    setDisabled(disabled: boolean): this {
        this.inputEl.disabled = disabled;
        return this;
    }

    onChange(cb: (val: string) => any): this {
        this.inputEl.addEventListener('change', () => cb(this.inputEl.value));
        this.inputEl.addEventListener('input', () => cb(this.inputEl.value));
        return this;
    }
}

export class ToggleComponent {
    toggleEl: HTMLInputElement;

    constructor(containerEl: HTMLElement) {
        this.toggleEl = containerEl.createEl('input', { type: 'checkbox' });
    }

    setValue(val: boolean): this {
        this.toggleEl.checked = val;
        return this;
    }

    getValue(): boolean {
        return this.toggleEl.checked;
    }

    onChange(cb: (val: boolean) => any): this {
        this.toggleEl.addEventListener('change', () => cb(this.toggleEl.checked));
        return this;
    }
}

export class SliderComponent {
    sliderEl: HTMLInputElement;

    constructor(containerEl: HTMLElement) {
        this.sliderEl = containerEl.createEl('input', { type: 'range' });
    }

    setLimits(min: number, max: number, step: number): this {
        this.sliderEl.min = String(min);
        this.sliderEl.max = String(max);
        this.sliderEl.step = String(step);
        return this;
    }

    setValue(val: number): this {
        this.sliderEl.value = String(val);
        return this;
    }

    getValue(): number {
        return parseFloat(this.sliderEl.value);
    }

    setDynamicTooltip(): this {
        return this;
    }

    onChange(cb: (val: number) => any): this {
        this.sliderEl.addEventListener('input', () => cb(parseFloat(this.sliderEl.value)));
        this.sliderEl.addEventListener('change', () => cb(parseFloat(this.sliderEl.value)));
        return this;
    }
}

export class ExtraButtonComponent {
    extraSettingsEl: HTMLElement;

    constructor(containerEl: HTMLElement) {
        this.extraSettingsEl = containerEl.createSpan({ cls: 'clickable-icon' });
    }

    setIcon(icon: string): this {
        setIcon(this.extraSettingsEl, icon);
        return this;
    }

    setTooltip(tooltip: string): this {
        this.extraSettingsEl.setAttribute('aria-label', tooltip);
        return this;
    }

    setDisabled(disabled: boolean): this {
        return this;
    }

    onClick(cb: () => any): this {
        this.extraSettingsEl.addEventListener('click', () => cb());
        return this;
    }
}

export class Setting {
    settingEl: HTMLElement;
    infoEl: HTMLElement;
    nameEl: HTMLElement;
    descEl: HTMLElement;
    controlEl: HTMLElement;

    constructor(public containerEl: HTMLElement) {
        this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
        this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
        this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
        this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
        this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
    }

    setName(name: string): this {
        this.nameEl.setText(name);
        return this;
    }

    setDesc(desc: string): this {
        this.descEl.setText(desc);
        return this;
    }

    addButton(cb: (btn: ButtonComponent) => any): this {
        const btn = new ButtonComponent(this.controlEl);
        cb(btn);
        return this;
    }

    addText(cb: (text: TextComponent) => any): this {
        const text = new TextComponent(this.controlEl);
        cb(text);
        return this;
    }

    addToggle(cb: (toggle: ToggleComponent) => any): this {
        const toggle = new ToggleComponent(this.controlEl);
        cb(toggle);
        return this;
    }

    addSlider(cb: (slider: SliderComponent) => any): this {
        const slider = new SliderComponent(this.controlEl);
        cb(slider);
        return this;
    }

    addExtraButton(cb: (btn: ExtraButtonComponent) => any): this {
        const btn = new ExtraButtonComponent(this.controlEl);
        cb(btn);
        return this;
    }

    addDropdown(cb: any): this {
        return this;
    }
}

export class PluginSettingTab {
    containerEl: HTMLElement;

    constructor(public app: App, public plugin: any) {
        this.containerEl = document.createElement('div');
    }

    display(): void {}
}

export class MenuItem {
    title: string = '';
    icon: string = '';
    clickHandler: (() => any) | null = null;

    setTitle(title: string): this {
        this.title = title;
        return this;
    }

    setIcon(icon: string): this {
        this.icon = icon;
        return this;
    }

    onClick(cb: () => any): this {
        this.clickHandler = cb;
        return this;
    }
}

export class Menu {
    items: (MenuItem | 'separator')[] = [];

    addItem(cb: (item: MenuItem) => any): this {
        const item = new MenuItem();
        cb(item);
        this.items.push(item);
        return this;
    }

    addSeparator(): this {
        this.items.push('separator');
        return this;
    }

    showAtMouseEvent(evt: MouseEvent): void {
        (this as any).shownAt = evt;
    }
}

export class MarkdownView {
    file: TFile | null = null;
    constructor(file?: TFile) {
        this.file = file ?? null;
    }
}

export class Plugin {
    app: App = new App();
    manifest: any = { id: 'test-plugin', dir: '.obsidian/plugins/test-plugin' };
    registeredViews: Record<string, (leaf: WorkspaceLeaf) => any> = {};
    statusBarItems: HTMLElement[] = [];
    commands: any[] = [];
    ribbonIcons: { icon: string; title: string; cb: (e: any) => any }[] = [];

    registerEvent(eventRef: any): void {}
    registerDomEvent(el: any, type: string, callback: any): void {}
    addCommand(command: any): void {
        this.commands.push(command);
    }
    addSettingTab(tab: any): void {}
    registerView(type: string, viewCreator: any): void {
        this.registeredViews[type] = viewCreator;
    }
    addStatusBarItem(): HTMLElement {
        const el = document.createElement('div');
        this.statusBarItems.push(el);
        return el;
    }
    addRibbonIcon(icon: string, title: string, callback: any): HTMLElement {
        this.ribbonIcons.push({ icon, title, cb: callback });
        const el = document.createElement('div');
        el.addEventListener('click', (e) => callback(e));
        return el;
    }
    async loadData(): Promise<any> { return {}; }
    async saveData(data: any): Promise<void> {}
}

export function setIcon(el: any, iconId: string): void {
    if (el && typeof el.setAttribute === 'function') {
        el.setAttribute('data-icon', iconId);
        el.classList?.add(`svg-icon-${iconId}`);
    }
}

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
    return { status: 200, headers: {}, text: '', json: {} };
}
