export default function RepliesLoading() {
  return (
    <div className="reply-inbox">
      <div className="filters">
        <span className="skeleton-block" style={{ width: 220 }} />
      </div>
      <ul className="reply-list" aria-label="Loading replies">
        {Array.from({ length: 5 }).map((_, index) => (
          <li className="reply-item" key={index}>
            <div className="reply-item-head">
              <span className="skeleton-block" style={{ width: 140 }} />
            </div>
            <p className="reply-body">
              <span className="skeleton-block" style={{ width: "70%" }} />
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
