import { UtensilsCrossed } from 'lucide-react';

/** Clean placeholder for a product/deal with no image_url — never a random
 *  stock photo (spec §19), just a quiet brand-tinted tile. */
export function ImageFallback({ className = '' }: { className?: string }) {
  return (
    <div className={`grid place-items-center bg-primary/[0.06] text-primary/30 ${className}`}>
      <UtensilsCrossed strokeWidth={1.5} className="w-[28%] h-[28%]" />
    </div>
  );
}
