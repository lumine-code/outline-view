const { CompositeDisposable, Emitter, TextEditor } = require("lumine");
const etch = require("@lumine-code/etch");

const OUTLINE_VIEW_URI = "lumine://outline-view";

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

function iconTargetForSymbol(symbol) {
  const explicit = symbol.icon;
  if (explicit?.startsWith("type-")) {
    return { kind: explicit.slice("type-".length), context: "outline-view" };
  }
  if (explicit) {
    const name = explicit.startsWith("icon-") ? explicit.slice("icon-".length) : explicit;
    return { name, context: "outline-view" };
  }
  const kind = symbol.tag ?? symbol.kind;
  return kind ? { kind, context: "outline-view" } : { name: "code", context: "outline-view" };
}

function titleForSymbol(symbol) {
  let kindTag = "";
  const kind = symbol.tag ?? symbol.kind;
  if (kind) {
    kindTag = ` (${kind})`;
  } else if (symbol.icon) {
    kindTag = ` (${symbol.icon})`;
  }
  return `${symbol.name}${kindTag}`;
}

// The dock item. Renders the symbols of the active editor as a collapsible
// tree and keeps the selection in sync with the editor's cursor.
class OutlineView {
  constructor(registry = null) {
    this.registry = null;
    this.registryDisposable = null;
    this.editorSymbolsList = new WeakMap();
    this.symbolEntryToRefTable = new Map();
    this.refToSymbolEntryTable = new Map();
    this.disposables = new CompositeDisposable();
    this.iconDisposables = new CompositeDisposable();
    this.emitter = new Emitter();
    this.symbols = null;
    this.selectedSymbol = null;
    this.selectedRef = null;
    this.activeEditor = null;
    this.activeEditorDisposables = null;
    this.symbolId = 1;
    this.searchQuery = "";
    this.searchResults = null;
    this.searchUpdateTimer = null;
    this.config = lumine.config.get("outline-view");

    etch.initialize(this);
    this.disposables.add(
      lumine.textEditors.add(this.refs.searchEditor),
      this.refs.searchEditor.onDidChange(() => {
        this.searchQuery = this.refs.searchEditor.getText();
        this.scheduleSearchUpdate();
      }),
    );

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
    this.setRegistry(registry);
  }

  async destroy() {
    clearTimeout(this.searchUpdateTimer);
    this.activeEditorDisposables?.dispose();
    this.registryDisposable?.dispose();
    this.iconDisposables.dispose();
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
      lumine.config.onDidChange("outline-view", ({ newValue }) => {
        this.config = newValue;
        this.update();
      }),
      lumine.workspace.getCenter().observeActivePaneItem((item) => {
        if (item === this.activeEditor) return;
        if (lumine.workspace.isTextEditor(item)) {
          this.switchToEditor(item);
        } else {
          this.clearActiveEditor();
        }
      }),
      lumine.commands.add(this.element, {
        "core:move-up": (event) => this.moveUp(event),
        "core:move-down": (event) => this.moveDown(event),
        "core:move-to-top": (event) => this.moveToTop(event),
        "core:move-to-bottom": (event) => this.moveToBottom(event),
        "outline-view:collapse-selected-entry": {
          description: "Collapse the selected symbol's children.",
          didDispatch: () => this.collapseSelectedEntry(),
        },
        "outline-view:activate-selected-entry": {
          description: "Jump the editor to the selected symbol.",
          didDispatch: () => this.activateSelectedEntry(),
        },
        "outline-view:clear-search": {
          description: "Empty the outline's search field.",
          didDispatch: () => this.clearSearch(),
        },
        "outline-view:focus-search": {
          description: "Put the cursor in the outline's search field.",
          didDispatch: () => this.focusSearch(),
        },
        "outline-view:toggle-search-focus": {
          description: "Move focus between the search field and the tree.",
          didDispatch: () => this.toggleSearchFocus(),
        },
        "outline-view:unfocus": {
          description: "Return focus to the editor, leaving the outline open.",
          didDispatch: () => this.unfocus(),
        },
      }),
    );

    this.element.addEventListener("focus", () => {
      if (!this.selectedRef) {
        this.moveToIndex(0);
      }
      this.selectedRef?.focus();
    });
  }

  setRegistry(registry) {
    this.registryDisposable?.dispose();
    this.registryDisposable = null;
    this.registry = registry;

    if (registry) {
      this.registryDisposable = registry.onDidInvalidateFileSymbols(({ editor }) => {
        if (!this.activeEditor) return;
        if (editor && editor !== this.activeEditor) return;
        this.populateForEditor(this.activeEditor);
      });
    }

    if (!this.activeEditor) return;
    if (!registry) this.setSymbols(null);
    else this.populateForEditor(this.activeEditor);
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
    this.activeEditor.setCursorBufferPosition(symbol.position, { autoscroll: false });
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
      editor.onDidChangeCursorPosition(({ cursor }) => {
        if (cursor !== editor.getLastCursor()) return;
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
    if (!this.registry) {
      this.setSymbols(null);
    } else {
      const cached = this.registry.peekFileSymbolTree(editor);
      this.setSymbols(cached ?? this.editorSymbolsList.get(editor) ?? []);
      this.populateForEditor(editor);
    }
    this.handleEditorEvents();
  }

  clearActiveEditor() {
    this.activeEditorDisposables?.dispose();
    this.activeEditorDisposables = null;
    this.selectedSymbol = null;
    this.selectedRef = null;
    this.activeEditor = null;
    this.setSymbols(null);
  }

  async populateForEditor(editor) {
    const symbols = await this.getSymbols(editor);
    if (!symbols) return;
    this.setSymbols(symbols, editor);
  }

  toggle() {
    return lumine.workspace.toggle(this);
  }

  // Reveal and focus the panel, or hand focus back to the editor when it
  // already has it. This is what the keystroke binds rather than `toggle`:
  // pressing it a second time should return you to your work, not hide a panel
  // you are looking at.
  async toggleFocus() {
    if (this.isFocused()) {
      this.unfocus();
      return;
    }
    await this.show();
    this.focus();
  }

  async show() {
    await lumine.workspace.open(this, {
      searchAllPanes: true,
      activatePane: false,
      activateItem: false,
    });
    this.activate();
  }

  activate() {
    const container = lumine.workspace.paneContainerForURI(this.getURI());
    if (!container || container === lumine.workspace.getCenter()) return;
    container.show();
    container.getActivePane().activateItemForURI(this.getURI());
    container.activate();
  }

  hide() {
    lumine.workspace.hide(this);
  }

  focus() {
    this.element.focus();
  }

  focusSearch() {
    this.refs.searchEditor?.element.focus();
  }

  toggleSearchFocus() {
    const searchElement = this.refs.searchEditor?.element;
    if (searchElement?.contains(document.activeElement)) {
      this.focus();
    } else {
      this.focusSearch();
    }
  }

  didMouseDownSearch(event) {
    if (event.target?.closest(".icon-remove-close")) return;
    const searchElement = this.refs.searchEditor?.element;
    if (searchElement && (!searchElement.hasFocus || !searchElement.hasFocus())) {
      event.preventDefault();
      searchElement.focus();
    }
  }

  clearSearch() {
    this.searchQuery = "";
    this.refs.searchEditor?.setText("");
    clearTimeout(this.searchUpdateTimer);
    return this.updateSearchResults();
  }

  scheduleSearchUpdate() {
    clearTimeout(this.searchUpdateTimer);
    this.searchUpdateTimer = setTimeout(() => this.updateSearchResults(), 50);
  }

  updateSearchResults() {
    this.searchResults = this.filterSymbols(this.searchQuery);
    return this.update().then(() => {
      const activeSymbol = this.getActiveSymbolForEditor(this.activeEditor);
      const preferredSymbol =
        (activeSymbol && this.elementForSymbol(activeSymbol) && activeSymbol) ||
        this.searchResults?.[0]?.symbol ||
        null;
      this.setSelectedSymbol(preferredSymbol);
    });
  }

  unfocus() {
    lumine.workspace.getCenter().getActivePane().activate();
  }

  setSymbols(symbols, editor) {
    if (editor && editor !== this.activeEditor) {
      // A stale response for an editor that is no longer active; remember it
      // so switching back to that editor is instant.
      this.editorSymbolsList.set(editor, symbols);
      return Promise.resolve();
    }
    this.symbols = symbols;
    if (this.activeEditor && symbols !== null) {
      this.editorSymbolsList.set(this.activeEditor, symbols);
    }
    this.searchResults = this.filterSymbols(this.searchQuery);
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

  async getSymbols(editor = this.activeEditor) {
    if (!editor || !this.registry) return null;
    return this.registry.getFileSymbolTree(editor);
  }

  update() {
    return etch.update(this).then(() => this.updateIcons());
  }

  updateIcons() {
    this.iconDisposables.dispose();
    this.iconDisposables = new CompositeDisposable();
    for (const [symbol, id] of this.symbolEntryToRefTable) {
      const element = this.refs?.[`symbol-icon-${id}`];
      if (!element) continue;
      this.iconDisposables.add(
        lumine.icons.applyTo(element, iconTargetForSymbol(symbol), { setData: false }),
      );
    }
  }

  renderSymbol(symbol, options = {}) {
    if (this.shouldIgnoreSymbol(symbol)) return null;
    const id = String(this.symbolId++);
    this.symbolEntryToRefTable.set(symbol, id);
    this.refToSymbolEntryTable.set(id, symbol);

    let children = null;
    if (symbol.children && !options.flat) {
      children = symbol.children.map((child) => this.renderSymbol(child)).filter(Boolean);
    }

    const nameContents = options.matches
      ? this.highlightMatches(symbol.name, options.matches)
      : [symbol.name];

    const name = etch.dom(
      "div",
      { className: "name" },
      etch.dom("span", { className: "outline-symbol-icon", ref: `symbol-icon-${id}` }),
      etch.dom("div", { className: "name-inner", title: titleForSymbol(symbol) }, ...nameContents),
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
    const symbolElements = this.searchResults
      ? this.searchResults
          .map(({ symbol, matches }) => this.renderSymbol(symbol, { flat: true, matches }))
          .filter(Boolean)
      : symbols.map((symbol) => this.renderSymbol(symbol)).filter(Boolean);
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
      const message = this.searchResults
        ? "No results"
        : this.symbols === null
          ? "This grammar is not supported"
          : "No symbols";
      contents = etch.dom(
        "background-tips",
        {},
        etch.dom("ul", { className: "centered background-message" }, etch.dom("li", {}, message)),
      );
    }

    const search = etch.dom(
      "div",
      {
        className: "outline-search",
        on: { mousedown: (event) => this.didMouseDownSearch(event) },
      },
      etch.dom(TextEditor, {
        ref: "searchEditor",
        mini: true,
        placeholderText: "Search...",
      }),
      etch.dom("div", {
        className: "icon-remove-close",
        on: {
          mousedown: (event) => event.preventDefault(),
          click: () => this.clearSearch(),
        },
      }),
    );

    return etch.dom(
      "div",
      { className: rootClasses, tabIndex: -1, ref: "root" },
      search,
      etch.dom("div", { className: "outline-scroller", ref: "scroller" }, contents),
    );
  }

  filterSymbols(query) {
    if (!query || this.symbols === null) return null;

    const normalizedQuery = lumine.tools.removeDiacritics(query);
    return this.getFlatSymbols()
      .map((symbol, index) => {
        const text = lumine.tools.removeDiacritics(symbol.name);
        const score = lumine.tools.fuzzyMatcher.score(text, normalizedQuery);
        const matches =
          score > 0
            ? lumine.tools.fuzzyMatcher.match(text, normalizedQuery, {
                recordMatchIndexes: true,
              }).matchIndexes
            : [];
        return {
          symbol,
          index,
          score,
          matches,
        };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
  }

  highlightMatches(text, matches) {
    const contents = [];
    let lastIndex = 0;
    for (const matchIndex of matches) {
      if (matchIndex > lastIndex) contents.push(text.slice(lastIndex, matchIndex));
      contents.push(etch.dom("span", { className: "character-match" }, text.charAt(matchIndex)));
      lastIndex = matchIndex + 1;
    }
    if (lastIndex < text.length) contents.push(text.slice(lastIndex));
    return contents;
  }

  shouldIgnoreSymbol(symbol) {
    const ignoredSymbolTypes = this.config?.ignoredSymbolTypes ?? [];
    if (symbol.kind && ignoredSymbolTypes.includes(symbol.kind)) return true;
    if (symbol.tag && ignoredSymbolTypes.includes(symbol.tag)) return true;
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
