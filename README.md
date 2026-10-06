# outline-view

Show a hierarchical symbol outline of the active editor.

The outline lives in a dock and follows the active editor: it lists the document's symbols as a collapsible tree, tracks the cursor, and jumps to a symbol when its entry is chosen.

## Features

- **Symbol tree**: renders the document's symbols as a collapsible tree in a dock item.
- **Navigation**: click an entry, or confirm it with the keyboard, to move the cursor to that symbol and focus the editor.
- **Cursor tracking**: marks the symbol containing the last cursor in bold and shades its ancestor branches in layers, independently of the temporary outline selection.
- **Live refresh**: rebuilds the outline as the buffer changes, honoring providers that prefer refresh on save.
- **Shared symbols**: renders the hierarchical tree cached by the symbol hub, shared with Go to Symbol and breadcrumbs.
- **Filtering**: hides chosen symbol kinds via the ignored-symbol-types setting.
- **Overflow control**: long names either scroll horizontally or truncate with an ellipsis.

## Installation

To install `outline-view` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/outline-view`.

## Commands

Commands available in `lumine-workspace`:

- `outline-view:show`: open the outline and reveal its dock,
- `outline-view:toggle`: show or hide the outline dock item,
- `outline-view:toggle-focus`: focus the outline, or return focus to the editor,
- `outline-view:reveal-in-outline-view`: reveal the symbol under the cursor in the outline.

Commands available in `.outline-view`:

- `outline-view:select-previous-entry`: select the previous visible symbol,
- `outline-view:select-next-entry`: select the next visible symbol,
- `outline-view:collapse-selected-entry`: collapse the selected branch, or select and collapse its parent,
- `outline-view:expand-selected-entry`: expand the selected branch,
- `outline-view:activate-selected-entry`: move to the selected symbol and focus its editor,
- `outline-view:activate-selected-entry-clear-search`: move to the selected symbol, clear search, and focus its editor,
- `outline-view:activate-selected-entry-add-cursor`: add a cursor at the selected symbol while keeping the outline focused,
- `outline-view:clear-search`: empty the outline's search field,
- `outline-view:focus-search`: focus the outline's search field,
- `outline-view:toggle-search-focus`: move focus between the search field and the symbol tree,
- `outline-view:unfocus`: return focus to the workspace center.

## Customization

The outline appearance can be tweaked from your `styles.css`:

```css
.outline-view {
  font-size: 12px;
  .name-inner {
    color: var(--text-color-highlight);
  }
}
```

## Services

- `symbol.registry`: consumed to render the symbol hub's cached document hierarchy.

Selecting a document symbol source in `symbol` also updates the outline and breadcrumbs. A file choice affects that editor, and a grammar preference applies to editors without a file choice. Auto restores the hub's normal source preference and fallback. During refreshes, the current outline stays visible for up to 200 ms and is replaced directly when new symbols arrive. A longer request clears the old entries until its result is ready.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
