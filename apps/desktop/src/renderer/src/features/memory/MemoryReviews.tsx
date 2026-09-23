import { useId } from "react";
import { MemoryReviewItem } from "./MemoryReviewItem.js";
import { useMemoryReviews } from "./use-memory-reviews.js";

export function MemoryReviews({
  agentId,
  pendingCount,
  disabled,
  onChanged,
}: {
  agentId: string;
  pendingCount: number;
  disabled: boolean;
  onChanged: () => void;
}) {
  const headingId = useId();
  const {
    items,
    nextCursor,
    loading,
    loadingMore,
    loadError,
    actionIds,
    actionErrors,
    reload,
    loadMore,
    actOnReview,
  } = useMemoryReviews(agentId, pendingCount, onChanged);

  if (pendingCount === 0) return null;
  return (
    <section className="memory-reviews" aria-labelledby={headingId}>
      <h3 id={headingId}>Changes to review ({pendingCount})</h3>
      {loadError && (
        <div className="memory-review-load-error" role="alert">
          <p className="error-message">{loadError}</p>
          <button type="button" className="button secondary" disabled={loading} onClick={reload}>
            Try again
          </button>
        </div>
      )}
      {loading && <p role="status">Loading reviews…</p>}
      {!loading && !loadError && items.length === 0 && (
        <p className="muted">No changes to review.</p>
      )}
      <div className="memory-review-list">
        {items.map((review) => (
          <MemoryReviewItem
            key={review.updateId}
            review={review}
            disabled={disabled}
            busy={actionIds.has(review.updateId)}
            error={actionErrors[review.updateId] || null}
            onAction={actOnReview}
          />
        ))}
      </div>
      {nextCursor && (
        <button
          type="button"
          className="button secondary"
          disabled={disabled || loading || loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
