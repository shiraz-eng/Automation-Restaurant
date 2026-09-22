/** A framed environmental photo used as the "photography" beat in the
 *  photography → product UI → workflow rhythm across feature sections —
 *  paired with a short caption naming what the platform does with that
 *  part of the real restaurant. */
export function PhotoPanel({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <div className="relative rounded-2xl overflow-hidden border border-border aspect-[4/3]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/0 to-black/0" />
      <div className="absolute left-4 right-4 bottom-4 text-white text-sm font-semibold drop-shadow">
        {caption}
      </div>
    </div>
  );
}
