import type { MemoryDocumentName, MemoryReview } from "@opensquad/core";
import { diffLines } from "./line-diff.js";

const documentLabels: Record<MemoryDocumentName, string> = {
  profile: "About you",
  preferences: "Preferences",
  notes: "Notes",
};

export type ReviewAction = "keep" | "undo";

export function MemoryReviewItem({
  review,
  disabled,
  busy,
  error,
  onAction,
}: {
  review: MemoryReview;
  disabled: boolean;
  busy: boolean;
  error: string | null;
  onAction: (review: MemoryReview, action: ReviewAction) => void;
}) {
  const stale = review.changes.some((change) => !change.current);
  const time = new Date(review.finishedAt ?? review.createdAt).toLocaleString();
  const sources = review.sources
    .map(
      (source) =>
        `Read: ${source.title ?? "Untitled conversation"} (${new Date(source.startedAt).toLocaleDateString()})`,
    )
    .join(", ");

  return (
    <article className="memory-review-item">
      <header className="memory-review-header">
        <h5>
          From your conversation with {review.agentName} · {time}
        </h5>
        {sources && <p className="muted memory-review-sources">{sources}</p>}
      </header>
      <ul className="memory-review-changes">
        {review.changes.map((change) => {
          const label =
            change.name === "notes" ? `Notes for ${review.agentName}` : documentLabels[change.name];
          const diff =
            change.before === null || change.after === null
              ? null
              : diffLines(change.before, change.after);
          const occurrences = new Map<string, number>();
          return (
            <li className="memory-review-change" key={`${change.name}:${change.toVersion}`}>
              <div className="memory-review-change-heading">
                <strong>{label}</strong>
                {change.name !== "notes" && (
                  <span className="memory-review-shared">Shared with all your bots</span>
                )}
              </div>
              {diff === null ? (
                <p className="muted memory-review-history-note">
                  This version is no longer in history.
                </p>
              ) : (
                <ol className="preserve-text memory-diff" aria-label={`${label} changes`}>
                  {diff.map((line) => {
                    const identity = `${line.type}:${line.text}`;
                    const occurrence = occurrences.get(identity) ?? 0;
                    occurrences.set(identity, occurrence + 1);
                    return (
                      <li
                        className={`memory-diff-line ${line.type}`}
                        key={`${identity}:${occurrence}`}
                      >
                        <span aria-hidden="true" className="memory-diff-marker">
                          {line.type === "added" ? "+ " : line.type === "removed" ? "− " : "  "}
                        </span>
                        {line.type !== "same" && (
                          <span className="sr-only">
                            {line.type === "added" ? "Added: " : "Removed: "}
                          </span>
                        )}
                        <span className="memory-diff-text">{line.text}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
      {stale && (
        <p className="memory-review-warning">
          Changed since this update. Use History to restore an older version.
        </p>
      )}
      {error && (
        <p role="alert" className="error-message memory-review-error">
          {error}
        </p>
      )}
      <div className="memory-review-actions">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || busy}
          onClick={() => onAction(review, "keep")}
        >
          Keep
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || busy || stale}
          onClick={() => onAction(review, "undo")}
        >
          Undo
        </button>
      </div>
    </article>
  );
}
