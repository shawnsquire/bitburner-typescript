/**
 * Minimal fake DOM for testing infiltration/casino solvers without jsdom.
 *
 * Implements just enough of Element/Document (tagName, textContent, style,
 * attributes, children, querySelector/querySelectorAll) to exercise the
 * small, fixed set of selectors the solvers under src/lib/infiltration and
 * src/lib/casino.ts actually use: plain tag names, ".class" selectors, the
 * ":scope > .class" child combinator, comma-separated lists ("h4, h5"), and
 * "tag[attr=\"value\"]" / "[attr=\"value\"]" attribute selectors.
 *
 * This is not a general CSS engine — it only supports the selector shapes
 * used by the solvers, matched by grep against their source.
 */
import type { DomUtils } from "/lib/dom";

export interface FakeSpec {
  tag: string;
  text?: string;
  className?: string;
  style?: Record<string, string>;
  attrs?: Record<string, string>;
  children?: FakeSpec[];
}

export class FakeElement {
  tagName: string;
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  style: Record<string, string>;
  private attrs: Record<string, string>;
  private ownText: string | undefined;

  constructor(spec: FakeSpec) {
    this.tagName = spec.tag.toUpperCase();
    this.style = { ...(spec.style ?? {}) };
    this.attrs = { ...(spec.attrs ?? {}) };
    if (spec.className) this.attrs.class = spec.className;
    this.ownText = spec.text;
    for (const childSpec of spec.children ?? []) {
      this.appendChild(new FakeElement(childSpec));
    }
  }

  appendChild(child: FakeElement): void {
    child.parentElement = this;
    this.children.push(child);
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  get className(): string {
    return this.attrs.class ?? "";
  }

  /** Own text if a leaf value was given, else the concatenation of descendant text. */
  get textContent(): string {
    if (this.ownText !== undefined) return this.ownText;
    return this.children.map(c => c.textContent).join("");
  }

  private matchesSimple(sel: string): boolean {
    // tag[attr="value"] or [attr="value"]
    const attrMatch = sel.match(/^([a-zA-Z0-9]*)\[([a-zA-Z0-9-]+)="([^"]*)"\]$/);
    if (attrMatch) {
      const [, tag, attr, value] = attrMatch;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      return this.getAttribute(attr) === value;
    }
    // .class
    if (sel.startsWith(".")) {
      return this.className.split(/\s+/).includes(sel.slice(1));
    }
    // tag
    return this.tagName === sel.toUpperCase();
  }

  private allDescendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) {
      out.push(c);
      out.push(...c.allDescendants());
    }
    return out;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.split(",").map(s => s.trim());
    const scopedParts = parts.filter(p => p.startsWith(":scope >")).map(p => p.slice(":scope >".length).trim());
    const plainParts = parts.filter(p => !p.startsWith(":scope >"));

    const results: FakeElement[] = [];
    // :scope > X only ever matches direct children — check those first in tree order.
    if (scopedParts.length > 0) {
      for (const child of this.children) {
        if (scopedParts.some(p => child.matchesSimple(p))) results.push(child);
      }
    }
    // Plain selectors match any descendant — walk depth-first so results come back
    // in real document order (querySelectorAll never returns selector-grouped order).
    if (plainParts.length > 0) {
      for (const el of this.allDescendants()) {
        if (plainParts.some(p => el.matchesSimple(p))) results.push(el);
      }
    }
    return results;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** Build a fake element tree from a plain spec object. */
export function fake(spec: FakeSpec): FakeElement {
  return new FakeElement(spec);
}

/**
 * Build a fake ".MuiContainer-root" > (papers...) structure like the game's
 * infiltration mini-game host, with `game` as the last (active) paper.
 */
export function fakeGameDoc(gamePaperChildren: FakeSpec[], priorPapers: FakeSpec[] = []): FakeElement {
  return fake({
    tag: "div",
    children: [
      {
        tag: "div",
        className: "MuiContainer-root",
        children: [
          ...priorPapers.map(p => ({ tag: "div", className: "MuiPaper-root", children: [p] })),
          { tag: "div", className: "MuiPaper-root", children: gamePaperChildren },
        ],
      },
    ],
  });
}

/**
 * Build just the "active game paper" element (what the real getGameContainer()
 * returns) — a bare ".MuiPaper-root" div with the given children, no wrapping
 * ".MuiContainer-root". Use this for dom.getGameContainer() fakes in solve()
 * tests; use fakeGameDoc for detect() tests, which need the full wrapper.
 */
export function fakeGamePaper(children: FakeSpec[]): FakeElement {
  return fake({ tag: "div", className: "MuiPaper-root", children });
}

/** Record of keys pressed via a fake DomUtils, in order. */
export interface FakeDomRecorder {
  keys: string[];
  typed: string[];
}

/**
 * A minimal DomUtils stub: sleep resolves immediately (no real waiting in
 * tests), pressKey/type record what was sent, getGameContainer returns the
 * fixed container passed in (or whatever `getContainer` returns, to model a
 * container that can "disappear" mid-solve by returning null/a new value).
 */
export function fakeDomUtils(
  container: FakeElement | (() => FakeElement | null),
): { dom: DomUtils; recorder: FakeDomRecorder } {
  const recorder: FakeDomRecorder = { keys: [], typed: [] };
  const getContainer = typeof container === "function" ? container : () => container;
  const dom: DomUtils = {
    query: () => null,
    queryRequired: () => { throw new Error("not implemented in fake"); },
    queryAll: () => [],
    waitForElement: () => Promise.reject(new Error("not implemented in fake")),
    waitForElementGone: () => Promise.resolve(),
    click: () => { /* noop */ },
    clickTrusted: () => { /* noop */ },
    type: (text: string) => { recorder.typed.push(text); },
    pressKey: (key: string) => { recorder.keys.push(key); },
    sleep: () => Promise.resolve(),
    getGameContainer: () => getContainer() as unknown as Element | null,
    getReactProps: () => null,
  };
  return { dom, recorder };
}
