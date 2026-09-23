'use client';

import { useMemo, useState } from 'react';
import { AdminCard, AdminInput } from './ui';

export type Column<T> = {
  key: string;
  label: string;
  render: (row: T) => React.ReactNode;
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right';
};

/**
 * Generic client-side sortable/searchable/paginated table shared by the
 * Customers and Restaurants directories. Client-side is sufficient at
 * current data volumes (tens to low hundreds of rows) — no server-side
 * pagination needed yet.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  searchPlaceholder = 'Search…',
  searchValue,
  onRowClick,
  pageSize = 25,
  emptyMessage = 'Nothing here yet.',
}: {
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  searchPlaceholder?: string;
  searchValue?: (row: T) => string;
  onRowClick?: (row: T) => void;
  pageSize?: number;
  emptyMessage?: string;
}) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!query.trim() || !searchValue) return rows;
    const q = query.trim().toLowerCase();
    return rows.filter((r) => searchValue(r).toLowerCase().includes(q));
  }, [rows, query, searchValue]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return filtered;
    return [...filtered].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
  }, [filtered, sortKey, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const pageRows = sorted.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
    setPage(0);
  }

  return (
    <div className="space-y-3">
      {searchValue && (
        <AdminInput
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder={searchPlaceholder}
          className="max-w-xs"
        />
      )}
      <AdminCard className="p-0 overflow-hidden">
        {rows.length === 0 ? (
          <p className="text-ink-muted text-xs p-4">{emptyMessage}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-ink-muted border-b border-white/10">
                  <tr>
                    {columns.map((c) => (
                      <th
                        key={c.key}
                        className={`p-3 font-semibold whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''} ${c.sortValue ? 'cursor-pointer select-none hover:text-ink-fg' : ''}`}
                        onClick={c.sortValue ? () => toggleSort(c.key) : undefined}
                      >
                        {c.label}
                        {sortKey === c.key ? (sortDir === 1 ? ' ↑' : ' ↓') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <tr
                      key={getRowId(row)}
                      className={`border-b border-white/10 last:border-0 align-top ${onRowClick ? 'cursor-pointer hover:bg-white/5' : ''}`}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                    >
                      {columns.map((c) => (
                        <td key={c.key} className={`p-3 ${c.align === 'right' ? 'text-right' : ''}`}>
                          {c.render(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between p-3 border-t border-white/10 text-xs text-ink-muted">
                <span>
                  {clampedPage * pageSize + 1}–{Math.min(sorted.length, (clampedPage + 1) * pageSize)} of {sorted.length}
                </span>
                <div className="flex gap-1.5">
                  <button
                    disabled={clampedPage === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="px-2 py-1 rounded border border-white/15 disabled:opacity-40 hover:bg-white/5"
                  >
                    Prev
                  </button>
                  <button
                    disabled={clampedPage >= totalPages - 1}
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    className="px-2 py-1 rounded border border-white/15 disabled:opacity-40 hover:bg-white/5"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </AdminCard>
    </div>
  );
}
