import { UtensilsCrossed } from 'lucide-react';

/** Clean placeholder for a product with no image_url — never a fabricated
 *  photo, just a quiet brand-tinted tile. */
export function ImageFallback({ className = '' }: { className?: string }) {
  return (
    <div className={`grid place-items-center bg-primary/[0.06] text-primary/30 ${className}`}>
      <UtensilsCrossed strokeWidth={1.5} className="w-[38%] h-[38%]" />
    </div>
  );
}
