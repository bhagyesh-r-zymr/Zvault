import { RATING_LABELS, type Rating } from './rating.js';

export function StrengthMeter({ rating, detail }: { rating: Rating; detail?: string }) {
  return (
    <div className="strength" data-rating={rating}>
      <meter min={0} max={4} low={2} high={3} optimum={4} value={rating} />
      <span>
        {RATING_LABELS[rating]}
        {detail && <span className="muted"> · {detail}</span>}
      </span>
    </div>
  );
}
