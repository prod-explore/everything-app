import { useEffect, useRef, useState } from 'react';

/** A long answer is parsed again for every chunk that arrives; at most this often (and on a frame boundary) is plenty. */
const STREAM_RENDER_MS = 90;

/** The text to show: while it streams, updated at most every STREAM_RENDER_MS on an animation frame; once complete, at once. */
export function useThrottledText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const lastShownAt = useRef(0);
  useEffect(() => {
    if (!streaming) return;
    const loop = { frame: 0 };
    const tick = () => {
      if (performance.now() - lastShownAt.current >= STREAM_RENDER_MS) {
        lastShownAt.current = performance.now();
        setShown(text);
      } else {
        loop.frame = requestAnimationFrame(tick);
      }
    };
    loop.frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(loop.frame);
  }, [text, streaming]);
  return streaming ? shown : text;
}
