const { CompositeDisposable, Emitter, Range } = require("atom");
const etch = require("@lumine-code/etch");

const OUTLINE_VIEW_URI = "atom://outline-view";

function classNames(...args) {
  const classes = [];
  for (const arg of args) {
    if (!arg) continue;
    if (typeof arg === "string") {
      classes.push(arg);
    } else {
      for (const key of Object.keys(arg)) {
        if (arg[key]) classes.push(key);
      }
    }
  }
  return classes.join(" ");
}

function interpretTokenizedText(tokenizedText) {
  return tokenizedText.map((token) => token.value).join("");
}

// Map an outline entry onto an Octicon class name. Providers either supply an
// `icon` directly (possibly a `type-*` value) or a `kind` (an LSP SymbolKind
// name), which is normalized to the same `type-*` vocabulary.
function octiconForSymbol(symbol) {
  const icon = symbol.icon ?? (symbol.kind ? `type-${symbol.kind}` : null);
  switch (icon) {
    case "type-function":
    case "type-method":
      return "icon-gear";
    case "type-namespace":
      return "icon-tag";
    case "type-variable":
      return "icon-code";
    case "type-class":
      return "icon-package";
    case "type-constant":
      return "icon-primitive-square";
    case "type-property":
      return "icon-primitive-dot";
    case "type-interface":
      return "icon-key";
    case "type-constructor":
      return "icon-tools";
    case "type-module":
      return "icon-database";
    default:
      // Fall back for all other `type-*` values; pass icon classes through.
      if (icon?.startsWith("type-")) return "icon-dash";
      return icon ?? null;
  }
}

function titleForSymbol(symbol) {
  let kindTag = "";
  if (symbol.kind) {
    kindTag = ` (${symbol.kind})`;
  } else if (symbol.icon) {
    kindTag = ` (${symbol.icon})`;
  }
  return `${symbol.name}${kindTag}`;
}

// The dock item. Renders the symbols of the active editor as a collapsible
// tree and keeps the selection in sync with the editor's cursor.
class OutlineView {
  constructor(broker) {
    this.broker = broker;
    this.editorSymbolsList = new WeakMap();
    this.symbolEntryToRefTable = new Map();
    this.refToSymbolEntryTable = new Map();
    this.disposables = new CompositeDisposable();
    this.emitter = new Emitter();
    this.symbols = null;
    this.selectedSymbol = null;
    this.selectedRef = null;
    this.activeEditor = null;
    this.activeEditorDisposables = null;
    this.activeProvider = null;
    this.symbolId = 1;
    this.config = atom.config.get("outline-view");

    etch.setScheduler(atom.views);
    etch.initialize(this);

    this.element.addEventListener("click", (event) => {
      if (!this.activeEditor) return;
      const target = event.target?.closest("li.outline-view-entry");
      if (!target) return;
      if (this.isClickOnCaret(event)) {
        this.collapseEntry(target);
        return;
      }
      const symbol = this.symbolForElement(target);
      if (!symbol) return;
      this.moveEditorToSymbol(symbol);
    });

    this.handleEvents();

    const editor = atom.workspace.getActiveTextEditor();
    if (editor) {
      this.switchToEditor(editor);
    }
  }

  async destroy() {
    this.activeEditorDisposables?.dispose();
    this.disposables.dispose();
    this.emitter.emit("did-destroy");
    await etch.destroy(this);
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  getTitle() {
    return "Outline";
  }

  getURI() {
    return OUTLINE_VIEW_URI;
  }

  getIconName() {
    return "list-unordered";
  }

  getAllowedLocations() {
    // When the workspace chooses a dock location for an item, it picks the
    // first one indicated in this array.
    if (this.config?.showOnRightSide) {
      return ["right", "left"];
    }
    return ["left", "right"];
  }

  isPermanentDockItem() {
    return false;
  }

  getPreferredWidth() {
    if (!this.refs?.list) return;
    this.refs.list.style.width = "min-content";
    const result = this.refs.list.offsetWidth;
    this.refs.list.style.width = "";
    return result;
  }

  handleEvents() {
    this.disposables.add(
      atom.config.onDidChange("outline-view", ({ newValue }) => {
        this.config = newValue;
        this.update();
      }),
      atom.workspace.onDidChangeActiveTextEditor((editor) => {
        // When the new active item isn't a text editor, keep showing the
        // previous editor's symbols.
        if (editor) {
          this.switchToEditor(editor);
        }
      }),
      atom.commands.add(this.element, {
        "core:move-up": (event) => this.moveUp(event),
        "core:move-down": (event) => this.moveDown(event),
        "core:move-to-top": (event) => this.moveToTop(event),
        "core:move-to-bottom": (event) => this.moveToBottom(event),
        "outline-view:collapse-selected-entry": () => this.collapseSelectedEntry(),
        "outline-view:activate-selected-entry": () => this.activateSelectedEntry(),
        "outline-view:unfocus": () => this.unfocus(),
      }),
    );

    this.element.addEventListener("focus", () => {
      if (!this.selectedRef) {
        this.moveToIndex(0);
      }
      this.selectedRef?.focus();
    });
  }

  isFocused() {
    const active = document.activeElement;
    return this.element === active || this.element.contains(active);
  }

  // Move the selection up to the previous item.
  moveUp(event) {
    return this.moveDelta(event, -1);
  }

  // Move the selection down to the next item.
  moveDown(event) {
    return this.moveDelta(event, 1);
  }

  moveDelta(event, delta) {
    event.stopImmediatePropagation();
    const items = this.getVisibleListItems();

    const symbol = this.getSelectedSymbol();
    if (!symbol) return;

    const element = this.elementForSymbol(symbol);
    if (!element) return;

    const index = items.indexOf(element);
    if (index === -1) return;

    let newIndex = index + delta;
    if (newIndex >= items.length) newIndex = items.length - 1;
    if (newIndex < 0) newIndex = 0;

    return this.moveToIndex(newIndex, items);
  }

  // Move to the symbol at the given index in the flat list of visible
  // symbols. A negative index counts from the end.
  moveToIndex(index, items) {
    if (!items) {
      items = this.getVisibleListItems();
    }
    if (items.length === 0) return;

    if (index < 0) {
      index = items.length + index;
    }

    const symbol = this.symbolForElement(items[index]);
    if (!symbol) return;

    this.setSelectedSymbol(symbol);
    if (this.config?.visitEntriesOnKeyboardMovement) {
      this.activateSelectedEntry();
    }
  }

  moveToTop(event) {
    event.stopImmediatePropagation();
    this.moveToIndex(0);
  }

  moveToBottom(event) {
    event.stopImmediatePropagation();
    this.moveToIndex(-1);
  }

  collapseSelectedEntry() {
    if (!this.selectedSymbol) return;
    const element = this.elementForSymbol(this.selectedSymbol);
    if (!element?.classList.contains("list-nested-item")) return;

    return this.collapseEntry(element);
  }

  collapseEntry(element) {
    const childrenGroup = element.querySelector(".list-tree");
    if (!childrenGroup) return;

    if (element.classList.contains("collapsed")) {
      childrenGroup.classList.remove("hidden");
      element.classList.remove("collapsed");
    } else {
      childrenGroup.classList.add("hidden");
      element.classList.add("collapsed");
    }
  }

  activateSelectedEntry() {
    if (!this.selectedSymbol) return;
    this.moveEditorToSymbol(this.selectedSymbol);
  }

  moveEditorToSymbol(symbol) {
    if (!symbol || !this.activeEditor) return;
    this.activeEditor.setCursorBufferPosition(symbol.range.start, { autoscroll: false });
    this.activeEditor.scrollToCursorPosition({ center: true });
  }

  elementForSymbol(symbol) {
    const ref = this.symbolEntryToRefTable.get(symbol);
    if (!ref) return null;
    return this.refs?.[ref] ?? null;
  }

  symbolForElement(element) {
    const ref = element.dataset.id;
    if (!ref) return null;
    return this.refToSymbolEntryTable.get(ref) ?? null;
  }

  handleEditorEvents() {
    const editor = this.activeEditor;
    const disposables = this.activeEditorDisposables;
    if (!editor || !disposables) return;

    disposables.add(
      editor.onDidStopChanging(() => {
        // Providers that opt out of `updateOnEdit` are refreshed on save only.
        if (this.activeProvider?.updateOnEdit === false) return;
        this.populateForEditor(editor);
      }),
      editor.onDidSave(() => {
        if (this.activeProvider?.updateOnEdit !== false) return;
        this.populateForEditor(editor);
      }),
      editor.onDidChangeCursorPosition(() => {
        const symbol = this.getActiveSymbolForEditor(editor);
        if (!symbol) return;
        this.setSelectedSymbol(symbol);
      }),
    );
  }

  switchToEditor(editor) {
    this.activeEditorDisposables?.dispose();
    this.selectedSymbol = null;
    this.selectedRef = null;

    this.activeEditor = editor;
    this.activeEditorDisposables = new CompositeDisposable();

    if (this.editorSymbolsList.has(editor)) {
      this.setSymbols(this.editorSymbolsList.get(editor) ?? []);
    } else {
      this.setSymbols([]);
      this.populateForEditor(editor);
    }
    this.handleEditorEvents();
  }

  async populateForEditor(editor) {
    const symbols = await this.getSymbols();
    if (!symbols) return;
    this.setSymbols(symbols, editor);
  }

  toggle() {
    return atom.workspace.toggle(this);
  }

  async show() {
    await atom.workspace.open(this, {
      searchAllPanes: true,
      activatePane: false,
      activateItem: false,
    });
    this.activate();
  }

  activate() {
    const container = atom.workspace.paneContainerForURI(this.getURI());
    if (!container || container === atom.workspace.getCenter()) return;
    container.show();
    container.getActivePane().activateItemForURI(this.getURI());
    container.activate();
  }

  hide() {
    atom.workspace.hide(this);
  }

  focus() {
    this.element.focus();
  }

  unfocus() {
    atom.workspace.getCenter().getActivePane().activate();
  }

  setSymbols(symbols, editor) {
    if (editor && editor !== this.activeEditor) {
      // A stale response for an editor that is no longer active; remember it
      // so switching back to that editor is instant.
      this.editorSymbolsList.set(editor, symbols);
      return Promise.resolve();
    }
    this.symbols = symbols;
    if (this.activeEditor) {
      this.editorSymbolsList.set(this.activeEditor, symbols);
    }
    return this.update().then(() => {
      const symbol = this.getActiveSymbolForEditor(this.activeEditor);
      if (!symbol) return;
      this.setSelectedSymbol(symbol);
    });
  }

  getActiveSymbolForEditor(editor, flatSymbols) {
    editor ??= this.activeEditor;
    if (!editor) return null;

    const position = editor.getLastCursor().getBufferPosition();
    const allSymbols = flatSymbols ?? this.getFlatSymbols();

    let candidate = null;
    for (const symbol of allSymbols) {
      const range = symbol.range;
      const { row } = position;
      if (range.start.row !== row && range.end.row !== row) {
        continue;
      }
      if (range.containsPoint(position)) {
        if (
          !candidate ||
          !candidate.range.containsPoint(position) ||
          range.compare(candidate.range) > 0
        ) {
          // Prefer whichever range is smaller, or else whichever one actually
          // contains the cursor instead of just touching the same row.
          candidate = symbol;
        }
      } else if (!candidate) {
        // Even without an exact match, use a symbol that touches the same row
        // as the cursor.
        candidate = symbol;
      }
    }

    return candidate;
  }

  setSelectedSymbol(newSymbol) {
    this.selectedRef?.classList.remove("selected");
    this.selectedSymbol = null;
    this.selectedRef = null;

    if (!newSymbol) return;

    const newElement = this.getClosestVisibleElementForSymbol(newSymbol);
    if (!newElement) return;

    this.selectedSymbol = newSymbol;
    this.selectedRef = newElement;
    this.selectedRef.classList.add("selected");
    this.scrollSelectedEntryIntoViewIfNeeded();
  }

  scrollSelectedEntryIntoViewIfNeeded() {
    if (!this.selectedRef) return;
    let element = this.selectedRef;
    if (element.classList.contains("list-nested-item")) {
      element = element.querySelector(".list-item");
    }
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const containerRect = this.element.getBoundingClientRect();

    if (rect.bottom > containerRect.height - 50 || rect.top < 50) {
      this.selectedRef.scrollIntoView();
      this.element.scrollLeft = 0;
    }
  }

  getSelectedSymbol() {
    return this.selectedSymbol;
  }

  getClosestVisibleElementForSymbol(symbol) {
    let element = this.elementForSymbol(symbol);
    if (!element) return null;

    while ((element?.offsetHeight ?? 1) === 0) {
      const parentNode = element?.parentNode;
      if (!parentNode) return null;
      element = parentNode.closest("li");
    }
    return element ?? null;
  }

  revealInOutlineView(editor) {
    const symbol = this.getActiveSymbolForEditor(editor);
    if (!symbol) return;

    const element = this.elementForSymbol(symbol);
    if (!element) return;

    while (element.offsetHeight === 0) {
      const nearestCollapsedNode = element.closest(".collapsed");
      if (!nearestCollapsedNode) break;
      this.collapseEntry(nearestCollapsedNode);
    }

    this.setSelectedSymbol(symbol);
  }

  async getSymbols() {
    if (!this.activeEditor) return null;

    const provider = this.broker.chooseProviderForEditor(this.activeEditor);
    this.activeProvider = provider;
    if (!provider) return null;

    const outline = await provider.getOutline(this.activeEditor);
    if (!outline) return null;

    return this.consumeOutline(outline);
  }

  // Convert an outline (per the `outline-view` service contract) into this
  // view's symbol entries. `startPosition`/`endPosition` are point-compatible
  // values — either `[row, column]` arrays or `Point`s — so real ranges are
  // constructed here.
  consumeOutline(outline) {
    function consumeSymbol(symbol) {
      const { icon, kind, plainText, tokenizedText, representativeName, startPosition } = symbol;
      const endPosition = symbol.endPosition ?? startPosition;
      const range = new Range(startPosition, endPosition);

      const name = tokenizedText
        ? interpretTokenizedText(tokenizedText)
        : (plainText ?? representativeName ?? "");

      const result = { icon, kind, name, range };
      if (symbol.children && symbol.children.length > 0) {
        result.children = symbol.children.map(consumeSymbol);
      }
      return result;
    }

    return outline.outlineTrees.map(consumeSymbol);
  }

  update() {
    return etch.update(this);
  }

  renderSymbol(symbol) {
    if (this.shouldIgnoreSymbol(symbol)) return null;
    const id = String(this.symbolId++);
    this.symbolEntryToRefTable.set(symbol, id);
    this.refToSymbolEntryTable.set(id, symbol);

    let children = null;
    if (symbol.children) {
      children = symbol.children.map((child) => this.renderSymbol(child)).filter(Boolean);
    }

    const name = etch.dom(
      "div",
      { className: classNames("name", octiconForSymbol(symbol)) },
      etch.dom("div", { className: "name-inner", title: titleForSymbol(symbol) }, symbol.name),
    );

    if (children && children.length > 0) {
      return etch.dom(
        "li",
        { className: "list-nested-item outline-view-entry", dataset: { id }, ref: id },
        etch.dom("div", { className: "outline-view-option list-item", tabIndex: -1 }, name),
        etch.dom("ul", { className: "outline-list list-tree" }, ...children),
      );
    }
    return etch.dom(
      "li",
      {
        className: "outline-view-entry outline-view-option list-item",
        tabIndex: -1,
        dataset: { id },
        ref: id,
      },
      name,
    );
  }

  render() {
    this.symbolEntryToRefTable.clear();
    this.refToSymbolEntryTable.clear();
    this.symbolId = 1;

    const symbols = this.symbols ?? [];
    const symbolElements = symbols.map((symbol) => this.renderSymbol(symbol)).filter(Boolean);
    const rootClasses = classNames("tool-panel", "outline-view", {
      "with-ellipsis-strategy": this.config?.nameOverflowStrategy === "ellipsis",
    });

    let contents;
    if (symbolElements.length > 0) {
      contents = etch.dom(
        "ul",
        {
          className:
            "outline-list outline-list-root full-menu focusable-panel list-tree has-collapsable-children",
          ref: "list",
        },
        ...symbolElements,
      );
    } else {
      contents = etch.dom(
        "ul",
        { className: "background-message", style: { display: "block" } },
        etch.dom("li", {}, "No Symbols"),
      );
    }

    return etch.dom("div", { className: rootClasses, tabIndex: -1, ref: "root" }, contents);
  }

  shouldIgnoreSymbol(symbol) {
    const ignoredSymbolTypes = this.config?.ignoredSymbolTypes ?? [];
    if (symbol.kind && ignoredSymbolTypes.includes(symbol.kind)) return true;
    if (symbol.icon && ignoredSymbolTypes.includes(symbol.icon)) return true;
    return false;
  }

  getFlatSymbols() {
    if (!this.symbols) return [];
    const results = [];
    const processSymbol = (symbol) => {
      if (this.shouldIgnoreSymbol(symbol)) return;
      results.push(symbol);
      for (const child of symbol.children ?? []) {
        processSymbol(child);
      }
    };
    for (const symbol of this.symbols) {
      processSymbol(symbol);
    }
    return results;
  }

  isClickOnCaret(event) {
    const element = event.target;
    if (element?.matches(".name")) return false;

    // The caret comes from generated content in a `::before` CSS rule. There
    // is no way to detect whether it was clicked on directly, but the space
    // allocated to the caret on the left side can be measured, telling
    // whether the mouse was in that zone.
    const elRect = element.getBoundingClientRect();
    const nameRect = element.querySelector(".name")?.getBoundingClientRect();
    if (!nameRect) return false;

    const distance = nameRect.left - elRect.left;
    return event.offsetX < distance;
  }

  getVisibleListItems() {
    const choices = this.element.querySelectorAll("li.list-item, li.list-nested-item");
    return Array.from(choices).filter((choice) => choice.offsetHeight > 0);
  }
}

module.exports = OutlineView;
