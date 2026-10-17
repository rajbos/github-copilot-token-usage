# Data tables (`renderDataTable`)

Every table in the VS Code extension's webviews is rendered by one shared
component, so tables look and behave the same in every panel:

| Concern | Where it lives |
|---|---|
| Markup, sorting, pagination, row filters, focus restore, screen-reader announcements, click wiring | [`vscode-extension/src/webview/shared/dataTable.ts`](../../vscode-extension/src/webview/shared/dataTable.ts) |
| Layout and styling (incl. high-contrast) | [`vscode-extension/src/webview/shared/dataTable.css`](../../vscode-extension/src/webview/shared/dataTable.css) |
| Pager / sort strings | `dataTable.*` keys in `package.nls.json` / `package.nls.zh-cn.json` |
| Tests | `vscode-extension/test/unit/webview-dataTable.test.ts` |

The Electron desktop app, Visual Studio extension and JetBrains plugin ship
the same webview bundles, so they get the same tables.

## Using it

```ts
import { renderDataTable, type DataTableColumn } from '../shared/dataTable';

const columns: DataTableColumn<ModelRow>[] = [
	{ id: 'model', label: localize('x.column.model'), sortValue: r => r.model, render: r => r.model },
	{ id: 'tokens', label: localize('x.column.tokens'), align: 'right', sortValue: r => r.tokens, render: r => formatNumber(r.tokens) },
	{ id: 'open', label: '', render: r => ({ html: `<button data-file="${escapeHtml(r.file)}">…</button>` }) },
];

setHtml(container, renderDataTable({
	tableId: 'model-usage',          // unique per document; keys the remembered state
	ariaLabel: localize('x.aria.models'),
	rows,
	columns,
	initialSort: { columnId: 'tokens', direction: 'desc' },
}));
```

That is all the wiring a view needs. Sort headers, pager buttons and filter
checkboxes are handled by one delegated listener per document, installed on
the first render; an interaction re-renders only that table, in place, from
the options it was last rendered with. Rendering again with the same
`tableId` (e.g. after new data arrives) keeps the user's sort, page and
filters.

### Rules of thumb

- **Pagination** — the default is 10 rows per page with a pager; tables that
  fit on one page show a "Showing 1–n of n" summary instead. Use
  `pageSize: false` only for fixed-structure tables whose rows are bounded by
  design (key/value detail tables, fixed comparison grids).
- **Sorting** — a column is sortable when it has a `sortValue` (return
  numbers as numbers, dates as timestamps; `null`/`undefined` always sort
  last). The first click sorts right-aligned (numeric) columns descending and
  other columns ascending; override with `firstSortDirection`. Without
  `initialSort` rows keep the order they were passed in.
- **Escaping** — a cell `render` that returns a string is escaped by the
  table. Returning `{ html }` is a trust boundary: every untrusted value in it
  (session titles, paths, tool/model names) must already be run through
  `escapeHtml`.
- **Styling** — don't restyle `.data-table` per view. Use the variants
  (`data-table--fixed`, `--compact`, `--nowrap`, `--key-value`,
  `data-table-root--scroll-y` on `rootClassName`), the cell helpers
  (`data-table-truncate`, `data-table-wrap-anywhere`, `data-table-muted`), a
  column `width`, or a column/row class for view-specific cell content.
- **Every view injects the stylesheet** next to `theme.css`
  (`import dataTableStyles from '../shared/dataTable.css'`); a unit test
  enforces this for every view that injects `theme.css`.

### Options beyond the basics

| Option | Use it for |
|---|---|
| `showHeader: false` + `className: 'data-table--key-value'` + `rowHeader: true` on the first column | Key/value detail tables |
| `rowOptions(row)` | A row class (e.g. highlight the current user) or `data-*` attributes |
| `afterRow(row)` | An extra row that travels with its row through sort/paging (expandable details) |
| `groupBy` | Group separator rows; sorting happens within each group |
| `footerRows` | Totals in a `<tfoot>` |
| `defaultFilters` + `filterRows` + `renderDataTableFilter()` | Checkbox filters that reset to page 1 |
| `headerHtml` / `headerTitle` | Rich or icon-only headers with an accessible name |
| `setDataTableState()` + `onStateChange` | Restoring and persisting the sort (e.g. through view state) |
| `onRender(root)` | Re-attaching listeners on custom cell content after an in-place re-render (prefer delegated listeners on a stable ancestor) |

## Out of scope

- The Chart view's calendar heatmap is a visualization grid, not a data
  table, and keeps its own markup.
- The team-server configuration panel's form layout table is host-generated
  HTML (nonce CSP, no webview bundle).
- The sharing server's own web pages (`sharing-server/`) are server-rendered
  by a separate package with its own privacy contract.
