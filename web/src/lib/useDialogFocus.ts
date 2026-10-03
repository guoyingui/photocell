import { useEffect, useRef } from 'react';

export function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (!node) return;
    const focusable = () => [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
      .filter((element) => !element.closest('[hidden]'));
    (node.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0] ?? node).focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const elements = focusable(), first = elements[0], last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); node.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    node.addEventListener('keydown', key);
    return () => { node.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, []);
  return ref;
}
