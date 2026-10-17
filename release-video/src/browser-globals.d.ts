/**
 * The handful of browser globals used inside `page.evaluate` callbacks.
 *
 * Those callbacks are serialized and run in the page, not in Node, so they
 * reference `document` — but adding `"dom"` to `lib` would declare the whole
 * browser API to every module here, and its `fetch`/`Response` types collide
 * with the Node ones the HTTP callers rely on. Declaring only what is actually
 * used keeps both halves honest: a typo in a page callback is still an error,
 * and Node code still cannot reach for a browser global by accident.
 */

declare type ScrollBehavior = 'auto' | 'instant' | 'smooth';

declare interface DomRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

declare interface PageElement {
	scrollIntoView(options?: { block?: string; inline?: string; behavior?: ScrollBehavior }): void;
	getBoundingClientRect(): DomRect;
}

declare const document: {
	getElementById(id: string): PageElement | null;
};
