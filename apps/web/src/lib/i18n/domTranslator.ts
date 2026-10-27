'use client';

import { fitsLanguageScript, samePlaceholders } from '@automation-restaurant/shared';
import { fillUiText, isTranslatable, normalizeUiText } from './normalize';

/**
 * Shows the restaurant portal in another language by translating the text the
 * page renders, in place: every text node and the placeholder / title /
 * aria-label / alt attributes. Known text comes from the bundled dictionary
 * (lib/i18n/dict/<lang>.json, synchronous, before paint); anything new — a dish
 * name, a fresh message — is translated by the API in small batches and cached
 * on this device.
 *
 * Only text values are changed, never the element structure, so React keeps
 * owning the DOM: when it re-renders a node with new English, the observer
 * sees the change and translates the new value.
 *
 * Left alone: anything inside [translate="no"] (AI chat messages, the language
 * menu), form values the person typed, code blocks, SVG, and text that is only
 * numbers, an email, a link or a code.
 */

type Fetcher = (keys: string[]) => Promise<Record<string, string>>;

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const;
const SKIP = '[translate="no"],.notranslate,script,style,noscript,code,pre,textarea,svg,[contenteditable="true"]';
const CACHE_MAX = 6000;

export class DomTranslator {
  private dict: Record<string, string>;
  private cache: Record<string, string>;
  private cacheKey: string;
  // What this translator last wrote, per node, so its own writes aren't re-translated.
  private written = new WeakMap<Node, string>();
  // The English a text node really holds (React's value), for nodes translated as part of a run.
  private source = new WeakMap<Text, string>();
  private attrWritten = new WeakMap<Element, Map<string, string>>();
  private pending = new Set<string>();
  private inflight = new Set<string>();
  private failed = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private titleObserver: MutationObserver | null = null;

  constructor(
    private lang: string,
    dict: Record<string, string>,
    private fetchMissing: Fetcher | null,
  ) {
    this.dict = dict;
    this.cacheKey = `ar-i18n:${lang}`;
    try {
      const stored = JSON.parse(localStorage.getItem(this.cacheKey) || '{}') as Record<string, string>;
      this.cache = Object.fromEntries(Object.entries(stored).filter(([k, v]) => this.usable(k, v)));
    } catch {
      this.cache = {};
    }
  }

  start(root: HTMLElement = document.body) {
    this.translateTree(root);
    this.translateTitle();
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData' && r.target.nodeType === Node.TEXT_NODE) this.translateText(r.target as Text);
        else if (r.type === 'attributes' && r.target instanceof Element && r.attributeName) this.translateAttr(r.target, r.attributeName);
        else if (r.type === 'childList') {
          r.addedNodes.forEach((n) => {
            if (n.nodeType === Node.TEXT_NODE) this.translateText(n as Text);
            else if (n instanceof Element) this.translateTree(n);
          });
          // A text run whose children changed is re-read as a whole.
          if (r.target instanceof Element && this.isRun(r.target)) this.translateRun(r.target);
        }
      }
    });
    this.observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
    const title = document.querySelector('title');
    if (title) {
      this.titleObserver = new MutationObserver(() => this.translateTitle());
      this.titleObserver.observe(title, { childList: true, characterData: true, subtree: true });
    }
  }

  stop() {
    this.observer?.disconnect();
    this.titleObserver?.disconnect();
    if (this.timer) clearTimeout(this.timer);
  }

  /** A translation that kept its placeholders and is written in the language's own script. */
  private usable(key: string, value: string): boolean {
    return !!value && samePlaceholders(key, value) && fitsLanguageScript(this.lang, value);
  }

  // ── Lookup ────────────────────────────────────────────────────────────────

  /** The translation of `text`, or null when there is none yet (queued) or it shouldn't change. */
  private lookup(text: string): string | null {
    const { key, nums } = normalizeUiText(text);
    if (!key || !isTranslatable(key)) return null;
    const lead = text.match(/^\s*/)![0];
    const trail = text.match(/\s*$/)![0];
    const hit = this.find(key);
    if (hit !== undefined) return lead + fillUiText(hit, nums) + trail;
    this.queue(key);
    return null;
  }

  private find(key: string): string | undefined {
    const direct = this.dict[key] ?? this.cache[key];
    if (direct !== undefined) return direct;
    // "Name:" / "Loading…" share the entry for "Name" / "Loading".
    const m = /^(.*?)([:：…]|\.\.\.)$/.exec(key);
    if (m && m[1]) {
      const base = this.dict[m[1]] ?? this.cache[m[1]];
      if (base !== undefined) return base + (m[2] === '...' ? '…' : m[2]);
    }
    return undefined;
  }

  private queue(key: string) {
    if (!this.fetchMissing || this.inflight.has(key)) return;
    const failedAt = this.failed.get(key);
    if (failedAt && Date.now() - failedAt < 60_000) return;
    this.pending.add(key);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), 300);
  }

  private async flush() {
    this.timer = null;
    const keys = [...this.pending].slice(0, 60);
    keys.forEach((k) => {
      this.pending.delete(k);
      this.inflight.add(k);
    });
    if (!keys.length || !this.fetchMissing) return;
    try {
      const got = await this.fetchMissing(keys);
      for (const k of keys) {
        const v = got[k];
        if (typeof v === 'string' && this.usable(k, v)) this.cache[k] = v;
        else this.failed.set(k, Date.now());
      }
      this.saveCache();
      this.translateTree(document.body);
    } catch {
      keys.forEach((k) => this.failed.set(k, Date.now()));
    } finally {
      keys.forEach((k) => this.inflight.delete(k));
      if (this.pending.size && !this.timer) this.timer = setTimeout(() => void this.flush(), 300);
    }
  }

  private saveCache() {
    const entries = Object.entries(this.cache);
    if (entries.length > CACHE_MAX) this.cache = Object.fromEntries(entries.slice(entries.length - CACHE_MAX));
    try {
      localStorage.setItem(this.cacheKey, JSON.stringify(this.cache));
    } catch {
      /* full or blocked: the page still shows the translations */
    }
  }

  // ── DOM ───────────────────────────────────────────────────────────────────

  private skipped(el: Element | null): boolean {
    return !el || !!el.closest(SKIP);
  }

  /** An element whose content is several text nodes (React renders "Only {n} left" as three). */
  private isRun(el: Element): boolean {
    if (el.childNodes.length < 2) return false;
    for (const c of el.childNodes) if (c.nodeType !== Node.TEXT_NODE && c.nodeType !== Node.COMMENT_NODE) return false;
    return true;
  }

  translateTree(root: Element) {
    if (this.skipped(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    for (const t of texts) this.translateText(t);
    const els = root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','));
    els.forEach((el) => ATTRS.forEach((a) => el.hasAttribute(a) && this.translateAttr(el, a)));
    ATTRS.forEach((a) => root.hasAttribute?.(a) && this.translateAttr(root, a));
  }

  private translateText(node: Text) {
    const parent = node.parentElement;
    if (this.skipped(parent)) return;
    if (parent!.tagName === 'TITLE') return;
    if (this.isRun(parent!)) return this.translateRun(parent!);
    const value = node.nodeValue ?? '';
    if (value === this.written.get(node)) return;
    const out = this.lookup(value);
    if (out !== null && out !== value) {
      this.written.set(node, out);
      node.nodeValue = out;
    }
  }

  private translateRun(el: Element) {
    if (this.skipped(el)) return;
    const texts = [...el.childNodes].filter((c): c is Text => c.nodeType === Node.TEXT_NODE);
    // Each child's real (English) value: what React last put there, not what we wrote.
    for (const t of texts) if (t.nodeValue !== this.written.get(t)) this.source.set(t, t.nodeValue ?? '');
    const english = texts.map((t) => this.source.get(t) ?? t.nodeValue ?? '').join('');
    const out = this.lookup(english);
    if (out === null) {
      // The whole sentence isn't known (yet): show each known piece translated meanwhile
      // ("Staff portal · /" + the slug), so nothing waits in English for the full line.
      texts.forEach((t) => {
        const src = this.source.get(t) ?? t.nodeValue ?? '';
        const piece = this.lookup(src);
        const v = piece ?? src;
        if (t.nodeValue !== v) {
          this.written.set(t, v);
          t.nodeValue = v;
        }
      });
      return;
    }
    if (out === english) return;
    texts.forEach((t, i) => {
      const v = i === 0 ? out : '';
      if (t.nodeValue !== v) {
        this.written.set(t, v);
        t.nodeValue = v;
      }
    });
  }

  private translateAttr(el: Element, name: string) {
    if (this.skipped(el)) return;
    // The language menu's own names, and input values, are never touched.
    const value = el.getAttribute(name);
    if (!value) return;
    const mine = this.attrWritten.get(el);
    if (mine?.get(name) === value) return;
    const out = this.lookup(value);
    if (out !== null && out !== value) {
      const map = mine ?? new Map<string, string>();
      map.set(name, out);
      this.attrWritten.set(el, map);
      el.setAttribute(name, out);
    }
  }

  private lastTitle = '';
  private translateTitle() {
    const t = document.title;
    if (!t || t === this.lastTitle) return;
    // "Inventory — BBQ Tonight": translate the screen name, keep the restaurant name.
    const [screen, ...rest] = t.split(' — ');
    const out = this.lookup(screen!);
    if (out !== null) {
      this.lastTitle = [out.trim(), ...rest].join(' — ');
      document.title = this.lastTitle;
    }
  }
}
