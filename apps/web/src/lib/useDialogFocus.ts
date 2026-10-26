'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0);
}

/**
 * Keyboard behaviour for a modal dialog or drawer, shared by every overlay:
 * focus moves into it when it opens (the element marked data-autofocus, or
 * the first control), Tab and Shift+Tab stay inside it, Escape calls onClose,
 * and focus goes back to whatever opened it when it closes.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose?: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0];
    // After the opening frame, so a slide-in transition doesn't scroll the page.
    const raf = requestAnimationFrame(() => (first ?? root).focus({ preventScroll: true }));
    if (!first && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeRef.current) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const a = items[0]!;
      const z = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === a || !root.contains(active))) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && (active === z || !root.contains(active))) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, ref]);
}
