export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand-mark" aria-label="UMC">
      UMC
      {compact ? null : <span>PHOTO BOOTH</span>}
    </span>
  );
}
