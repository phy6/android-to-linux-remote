import React, { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, X } from 'lucide-react';

interface ScanPairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Called with the decoded QR text. Return true if it was accepted (the modal
   * stays open but stops scanning), or false to keep scanning — e.g. the code
   * was not a TailDeck pairing code.
   */
  onResult: (raw: string) => boolean;
}

// Phone side: scan the QR the laptop shows, so connecting never means typing an
// address or guessing which route to take.
export const ScanPairingModal: React.FC<ScanPairingModalProps> = ({ isOpen, onClose, onResult }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const handledRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);

  // Keep the latest handler without restarting the camera when it changes
  // identity (it is rebuilt on every parent render).
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  });

  useEffect(() => {
    if (!isOpen) return;
    handledRef.current = false;
    setError(null);
    setRejected(false);
    let cancelled = false;

    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const image = ctx.getImageData(0, 0, w, h);
      const code = jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data && !handledRef.current) {
        const accepted = onResultRef.current(code.data);
        if (accepted) {
          handledRef.current = true;
          return;
        }
        // Not a TailDeck code: flash a hint and keep looking.
        setRejected(true);
        window.setTimeout(() => setRejected(false), 1500);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.setAttribute('playsinline', 'true');
          void video.play().catch(() => {});
        }
        rafRef.current = requestAnimationFrame(tick);
      })
      .catch((err: unknown) => {
        const name = (err as { name?: string } | undefined)?.name;
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was blocked. Allow it for this site and try again.'
            : 'No camera is available on this device.',
        );
      });

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/90 animate-fadeIn" onClick={onClose} />

      <div className="relative w-full max-w-sm">
        <button
          onClick={onClose}
          className="absolute -top-12 right-0 p-2 rounded-xl bg-slate-900/80 text-slate-300 hover:text-white"
          aria-label="Close scanner"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="relative rounded-2xl overflow-hidden border border-slate-800 bg-black aspect-square">
          <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
          <canvas ref={canvasRef} className="hidden" />

          {/* Framing reticle */}
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="w-3/5 h-3/5 rounded-2xl border-2 border-sky-400/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
          </div>

          {error && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
              <p className="text-sm text-rose-300">{error}</p>
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center justify-center gap-2 text-xs text-slate-400">
          <Camera className="w-4 h-4" />
          <span>{rejected ? 'That is not a TailDeck code — keep scanning.' : 'Point at the QR on your laptop.'}</span>
        </div>
      </div>
    </div>
  );
};
