import type { ButtonConfig } from './buttonConfig';

/**
 * Creates an HTML element with optional className and textContent.
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) { node.className = className; }
	if (text !== undefined) { node.textContent = text; }
	return node;
}

/**
 * Creates a vscode-button element with the specified attributes.
 * Accepts either individual parameters or a ButtonConfig object.
 */
export function createButton(config: ButtonConfig): HTMLElement;
export function createButton(id: string, label: string, appearance?: 'primary' | 'secondary'): HTMLElement;
export function createButton(configOrId: ButtonConfig | string, label?: string, appearance?: 'primary' | 'secondary'): HTMLElement {
	const button = document.createElement('vscode-button');
	
	if (typeof configOrId === 'string') {
		// Legacy signature: createButton(id, label, appearance)
		button.id = configOrId;
		button.textContent = label || '';
		if (appearance) { button.setAttribute('appearance', appearance); }
	} else {
		// New signature: createButton(config)
		const config = configOrId;
		button.id = config.id;
		button.textContent = config.label;
		if (config.appearance) { button.setAttribute('appearance', config.appearance); }
	}
	
	return button;
}
