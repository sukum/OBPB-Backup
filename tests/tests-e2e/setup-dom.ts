import { JSDOM } from 'jsdom';

/**
 * Initializes a full JSDOM environment and decorates prototypes with
 * Obsidian-specific DOM convenience helpers.
 */
export function setupDomEnvironment(): JSDOM {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'http://localhost/',
        pretendToBeVisual: true,
    });

    const { window } = dom;

    (globalThis as any).window = window;
    (globalThis as any).document = window.document;
    (globalThis as any).HTMLElement = window.HTMLElement;
    (globalThis as any).HTMLDivElement = window.HTMLDivElement;
    (globalThis as any).HTMLSpanElement = window.HTMLSpanElement;
    (globalThis as any).HTMLButtonElement = window.HTMLButtonElement;
    (globalThis as any).HTMLInputElement = window.HTMLInputElement;
    (globalThis as any).HTMLSelectElement = window.HTMLSelectElement;
    (globalThis as any).HTMLParagraphElement = window.HTMLParagraphElement;
    (globalThis as any).HTMLHeadingElement = window.HTMLHeadingElement;
    (globalThis as any).HTMLAnchorElement = window.HTMLAnchorElement;
    (globalThis as any).DocumentFragment = window.DocumentFragment;
    (globalThis as any).Node = window.Node;
    (globalThis as any).Element = window.Element;
    (globalThis as any).Event = window.Event;
    (globalThis as any).CustomEvent = window.CustomEvent;
    (globalThis as any).MouseEvent = window.MouseEvent;

    const nodeProto = window.Node.prototype as any;
    const proto = window.HTMLElement.prototype as any;
    const docFragProto = window.DocumentFragment.prototype as any;

    const createElHelper = function (this: any, tag: string, o?: any, callback?: any) {
        const el = window.document.createElement(tag);
        if (typeof o === 'string') {
            el.className = o;
        } else if (o) {
            if (o.cls) {
                if (Array.isArray(o.cls)) {
                    el.classList.add(...o.cls);
                } else if (typeof o.cls === 'string') {
                    el.className = o.cls;
                }
            }
            if (o.text !== undefined) {
                el.textContent = String(o.text);
            }
            if (o.attr) {
                for (const [key, val] of Object.entries(o.attr)) {
                    if (val !== null && val !== undefined) {
                        el.setAttribute(key, String(val));
                    }
                }
            }
            if (o.title) el.title = o.title;
            if (o.value !== undefined) (el as any).value = o.value;
            if (o.type && 'type' in el) (el as any).type = o.type;
            if (o.placeholder && 'placeholder' in el) (el as any).placeholder = o.placeholder;
            if (o.href && 'href' in el) (el as any).href = o.href;
        }
        if (o?.prepend) {
            this.prepend(el);
        } else {
            this.appendChild(el);
        }
        if (callback) callback(el);
        return el;
    };

    nodeProto.createEl = createElHelper;
    docFragProto.createEl = createElHelper;

    const createDivHelper = function (this: any, o?: any, callback?: any) {
        return this.createEl('div', o, callback);
    };
    nodeProto.createDiv = createDivHelper;
    docFragProto.createDiv = createDivHelper;

    const createSpanHelper = function (this: any, o?: any, callback?: any) {
        return this.createEl('span', o, callback);
    };
    nodeProto.createSpan = createSpanHelper;
    docFragProto.createSpan = createSpanHelper;

    nodeProto.empty = function (this: any) {
        while (this.firstChild) {
            this.removeChild(this.firstChild);
        }
    };
    docFragProto.empty = nodeProto.empty;

    nodeProto.detach = function (this: any) {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    };

    proto.setText = function (this: any, val: any) {
        this.textContent = typeof val === 'string' ? val : (val?.textContent ?? '');
    };
    proto.getText = function (this: any) {
        return this.textContent ?? '';
    };

    proto.addClass = function (this: any, ...classes: string[]) {
        for (const cls of classes) {
            if (cls) this.classList.add(cls);
        }
    };

    proto.onClickEvent = function (this: any, callback: (event: MouseEvent) => unknown) {
        this.addEventListener('click', callback);
    };

    proto.removeClass = function (this: any, ...classes: string[]) {
        for (const cls of classes) {
            if (cls) this.classList.remove(cls);
        }
    };

    proto.toggleClass = function (this: any, classes: string | string[], value: boolean) {
        const list = Array.isArray(classes) ? classes : [classes];
        for (const cls of list) {
            if (value) {
                this.classList.add(cls);
            } else {
                this.classList.remove(cls);
            }
        }
    };

    (globalThis as any).createFragment = function (callback?: (frag: DocumentFragment) => void): DocumentFragment {
        const frag = window.document.createDocumentFragment();
        if (callback) callback(frag);
        return frag;
    };

    return dom;
}

// Automatically initialize once on load
setupDomEnvironment();
