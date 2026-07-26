# outline-view

Show a hierarchical symbol outline of the active editor.

The outline lives in a dock and follows the active editor: it lists the document's symbols as a collapsible tree, tracks the cursor, and jumps to a symbol when its entry is chosen.

## Features

- **Symbol tree**: renders the document's symbols as a collapsible tree in a dock item.
- **Navigation**: click an entry, or confirm it with the keyboard, to move the cursor to that symbol.
- **Cursor tracking**: selects the entry of the symbol under the cursor as it moves through the file.
- **Live refresh**: rebuilds the outline as the buffer changes, honoring providers that prefer refresh on save.
- **Provider based**: sources outlines from language servers, with a fallback that assembles symbol providers into an outline.
- **Filtering**: hides chosen symbol kinds via the ignored-symbol-types setting.
- **Overflow control**: long names either scroll horizontally or truncate with an ellipsis.

## Installation

To install `outline-view` search for _outline-view_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/outline-view`.

## Commands

Commands available in `atom-workspace`:

- `outline-view:show`: open the outline and reveal its dock,
- `outline-view:toggle`: toggle the outline dock item.

Commands available in `atom-text-editor`:

- `outline-view:reveal-in-outline-view`: select the symbol under the cursor in the outline.

Commands available in `.outline-view`:

- `outline-view:activate-selected-entry`: move the editor to the selected symbol,
- `outline-view:collapse-selected-entry`: collapse or expand the selected entry,
- `outline-view:unfocus`: return focus to the workspace center.

## Customization

The outline appearance can be tweaked from your `styles.less`:

```less
.outline-view {
  font-size: 12px;
  .name-inner {
    color: var(--text-color-highlight);
  }
}
```

## Services

- **outline.provider** (`^1.0.0`): consumed to receive document outlines from language servers and other outline providers.
- **symbol.provider** (`^1.0.0`): consumed to build a fallback outline from symbol providers when no outline provider matches the editor.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
