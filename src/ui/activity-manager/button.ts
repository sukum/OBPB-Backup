import { setIcon } from 'obsidian';

export interface ButtonOptions {
    parent: HTMLElement;
    cls?: string;
    text?: string;
    ariaLabel?: string;
    icon?: string;
    onClick?: (event: MouseEvent) => void | Promise<void>;
}

/**
 * Consolidates button creation across activity manager views.
 * Configures parent element, CSS classes, text content, aria-label (defaulting to text),
 * icon, and click event handler.
 */
export function createButton(options: ButtonOptions): HTMLButtonElement {
    const { parent, cls, text, ariaLabel, icon, onClick } = options;
    const btn = parent.createEl('button', {
        cls,
        text,
    });

    const label = ariaLabel ?? text;
    if (label) {
        btn.setAttribute('aria-label', label);
    }

    if (icon) {
        setIcon(btn, icon);
    }

    if (onClick) {
        // onclick could be synronous or async, so we wrap it in Promise.resolve to handle both cases
        btn.addEventListener('click', (event) => {
            Promise.resolve(onClick(event)).catch((err) => {
                console.error('Unhandled click error:', err);
            });
        });
    }

    return btn;
}
