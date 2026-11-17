import { useSyncExternalStore } from 'react';

/** Whether a CSS media query matches right now, and keeps up when it changes (a tablet docked to a keyboard, a rotated phone). */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    notify => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener('change', notify);
      return () => mq.removeEventListener('change', notify);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** The main pointer is a finger: no hover, Enter in the message box is a line break, Escape is not a thing. */
export const TOUCH_PRIMARY_QUERY = '(pointer: coarse) and (not (any-pointer: fine))';
export const useTouchPrimary = (): boolean => useMedia(TOUCH_PRIMARY_QUERY);
/** The device can hover, so controls may wait for the pointer; without it they have to be on screen. */
export const useCanHover = (): boolean => useMedia('(hover: hover)');
