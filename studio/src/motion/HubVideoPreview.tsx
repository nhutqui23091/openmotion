import { useEffect, useRef, useState } from 'react';
import type { HubVideo } from './gemini4Videos';

const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** Detail playback keeps the original no-referrer document and native controls. */
export function previewDocument(video: HubVideo, src = video.video, controls = false) {
  return `<meta name="referrer" content="no-referrer"><style>html,body{margin:0;height:100%;overflow:hidden;background:${controls ? 'black' : 'transparent'}}video{width:100%;height:100%;object-fit:${controls ? 'contain' : 'cover'};display:block}</style><video src="${escape(src)}"${controls ? ` poster="${escape(video.poster)}"` : ''} muted autoplay loop playsinline${controls ? ' controls' : ''}></video>`;
}

export function HubVideoPreview({ video }: { video: HubVideo }) {
  const player = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const element = player.current;
    if (!element) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setReady(false);
    // Native video requests cannot set a per-element referrer policy. X rejects
    // localhost referrers; fetch explicitly without one, then play the same bytes.
    void (async () => {
      try {
        const response = await fetch(video.video, { referrerPolicy: 'no-referrer', signal: controller.signal });
        if (!response.ok) throw new Error(`Video preview HTTP ${response.status}`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        element.src = objectUrl;
        element.muted = true;
        await element.play();
      } catch {
        if (!controller.signal.aborted) setReady(false);
      }
    })();
    return () => {
      controller.abort();
      element.pause();
      element.removeAttribute('src');
      element.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [video.video]);
  return <video ref={player} className="om-gallery-animation" style={{ opacity: ready ? 1 : 0 }}
    muted loop playsInline autoPlay preload="auto" aria-hidden="true"
    onPlaying={() => {
      const element = player.current;
      if (!element) return;
      if (element.requestVideoFrameCallback) element.requestVideoFrameCallback(() => setReady(true));
      else if (element.readyState >= 2) setReady(true);
    }} onError={() => setReady(false)} onEmptied={() => setReady(false)} />;
}
