/** One line of an impact list: `key` identifies the row, `title` is shown. */
export interface ImpactTitleItem {
  key: string;
  title: string;
}

/**
 * The list used by both the exit dialog and the close dialog for running terminals and unsaved
 * files. The markup is the one the dialogs always rendered (m6-095).
 */
export function ImpactTitleList({
  items,
}: {
  items: readonly ImpactTitleItem[];
}) {
  return (
    <ul className="app-exit-unsaved-files">
      {items.map((item) => (
        <li key={item.key}>{item.title}</li>
      ))}
    </ul>
  );
}
