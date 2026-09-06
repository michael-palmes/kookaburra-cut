import type { RefObject } from "react";

export function LibraryModalHeader({
  title,
  titleId,
  query,
  onQueryChange,
  searchRef,
  searchLabel,
  placeholder,
  busy = false,
  onClose,
}: {
  title: string;
  titleId?: string;
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  searchLabel: string;
  placeholder: string;
  busy?: boolean;
  onClose: () => void;
}) {
  return (
    <div className="add-scene-head">
      <h2 id={titleId}>{title}</h2>
      <div className="add-scene-search">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
          <path
            d="M10.5 10.5 14 14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        <input
          ref={searchRef}
          className="modal-input"
          type="search"
          placeholder={placeholder}
          aria-label={searchLabel}
          value={query}
          disabled={busy}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>
      <button
        type="button"
        className="modal-close"
        aria-label="Close"
        disabled={busy}
        onClick={onClose}
      />
    </div>
  );
}
