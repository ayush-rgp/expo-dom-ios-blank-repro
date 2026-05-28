'use dom';

import React, { useEffect } from 'react';

type Item = { id: number; text: string };

interface Props {
  items: Item[];
  // Optional debug callback bridged back to RN console.
  onDomDebug?: (event: string, data?: any) => void;
}

/**
 * Minimal "use dom" component for reproducing the iOS WKWebView blank bug.
 *
 * - When `items` is small (1-2 items, short text), this renders correctly.
 * - When `items` is large (e.g. 30 items × 50 lorem-ipsum repeats, ~30 KB
 *   serialized through the bridge), the WebView mounts but stays blank on
 *   iOS — iOS WKWebView kills the content process before this component's
 *   bundle finishes its first paint. The `onDomDebug('mount', ...)` call
 *   below NEVER fires for the failing case (no proof of execution).
 */
export default function DomComponent({ items, onDomDebug }: Props) {
  useEffect(() => {
    onDomDebug?.('mount', {
      ts: Date.now(),
      itemsCount: items?.length ?? 0,
      bodyHeight:
        typeof document !== 'undefined' ? document.body?.clientHeight : -1,
      visualViewport:
        typeof window !== 'undefined' ? window.visualViewport?.height : -1,
    });
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(() => {
        onDomDebug?.('post-paint', {
          ts: Date.now(),
          bodyHeight: document.body?.clientHeight,
          bodyRect: document.body?.getBoundingClientRect()?.height,
        });
      });
      return () => cancelAnimationFrame(raf2);
    });
    return () => cancelAnimationFrame(raf1);
  }, []);

  return (
    <div
      style={{
        padding: 16,
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        fontSize: 14,
        lineHeight: 1.5,
        color: '#111',
      }}
    >
      <h1 style={{ fontSize: 22, margin: '0 0 12px' }}>
        DomComponent mounted ({items?.length ?? 0} items)
      </h1>
      <p style={{ margin: '0 0 16px', color: '#555' }}>
        If you can read this text, the DOM bundle executed.
      </p>
      {(items ?? []).map((i) => (
        <p key={i.id} style={{ margin: '0 0 12px' }}>
          <strong>#{i.id}</strong> {i.text}
        </p>
      ))}
    </div>
  );
}
