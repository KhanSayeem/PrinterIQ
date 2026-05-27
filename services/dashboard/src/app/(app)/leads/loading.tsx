export default function LeadsLoading() {
  return (
    <div className="leads-screen">
      <div className="leads-list">
        <div className="filters"><span className="skeleton-block" style={{ width: 220 }} /></div>
        <div className="table-wrap">
          <table>
            <tbody>
              {Array.from({ length: 8 }).map((_, index) => (
                <tr className="skeleton-row" key={index}>
                  <td><span /></td><td><span /></td><td><span /></td><td><span /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <aside className="detail-panel"><div className="empty-state">Loading leads...</div></aside>
    </div>
  );
}
