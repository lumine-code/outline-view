const { CompositeDisposable, Emitter, TextEditor } = require("lumine");
const etch = require("@lumine-code/etch");

const OUTLINE_VIEW_URI = "lumine://outline-view";
const SYMBOL_REFRESH_GRACE_PERIOD = 200;

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
// tree with independent cursor tracking and temporary keyboard selection.
class OutlineView {
  constructor(registry = null) {
    this.registry = null;
    this.registryDisposable = null;
    this.editorSymbolsList = new WeakMap();
    this.symbolRequests = new WeakMap();
    this.symbolRefresh = null;
    this.destroyed = false;
    this.symbolEntryToRefTable = new Map();
    this.refToSymbolEntryTable = new Map();
    this.disposables = new CompositeDisposable();
    this.iconDisposables = new CompositeDisposable();
    this.emitter = new Emitter();
    this.symbols = null;
    this.currentSymbol = null;
    this.currentRef = null;
    this.currentStackRefs = [];
    this.selectedSymbol = null;
    this.selectedRef = null;
    this.selectionBeforeRefresh = null;
    this.selectionResetTimer = null;
    this.activeEditor = null;
    this.activeEditorDisposables = null;
    this.symbolId = 1;
    this.searchQuery = "";
    this.searchResults = null;
    this.searchUpdateTimer = null;
    this.config = lumine.config.get("outline-view");

    etch.initialize(this);
    this.disposables.add(
      lumine.textEditors.add(this.refs.searchEditor, { role: "input" }),
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
      this.activateSymbol(symbol, { addCursor: event.ctrlKey, clearSearch: event.altKey });
    });

    this.handleEvents();
    this.setRegistry(registry);
  }

  async destroy() {
    this.destroyed = true;
    this.symbolRequests = new WeakMap();
    this.clearSymbolRefresh();
    clearTimeout(this.searchUpdateTimer);
    clearTimeout(this.selectionResetTimer);
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

  serialize() {
    return { deserializer: "outline-view/OutlineView" };
  }

  getIconName() {
    return "list-unordered";
  }

  getDefaultLocation() {
    return this.config?.showOnRightSide ? "right" : "left";
  }

  getAllowedLocations() {
    // When the workspace chooses a dock location for an item, it picks the
    // first one indicated in this array.
    return this.getDefaultLocation() === "left" ? ["left", "right"] : ["right", "left"];
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
        "outline-view:select-previous-entry": {
          description: "Select the previous visible symbol without leaving the outline.",
          didDispatch: (event) => this.moveUp(event),
        },
        "outline-view:select-next-entry": {
          description: "Select the next visible symbol without leaving the outline.",
          didDispatch: (event) => this.moveDown(event),
        },
        "outline-view:collapse-selected-entry": {
          description: "Collapse the selected branch, or select and collapse its parent.",
          didDispatch: () => this.collapseSelectedEntry(),
        },
        "outline-view:expand-selected-entry": {
          description: "Expand the selected symbol's children.",
          didDispatch: () => this.expandSelectedEntry(),
        },
        "outline-view:activate-selected-entry": {
          description: "Jump to the selected symbol and focus its editor.",
          didDispatch: () => this.activateSelectedEntry(),
        },
        "outline-view:activate-selected-entry-clear-search": {
          description: "Jump to the selected symbol, clear search, and focus its editor.",
          didDispatch: () => this.activateSelectedEntry({ clearSearch: true }),
        },
        "outline-view:activate-selected-entry-add-cursor": {
          description: "Add a cursor at the selected symbol, keeping the outline focused.",
          didDispatch: () => this.activateSelectedEntry({ addCursor: true }),
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

    this.element.addEventListener("focus", () => this.focus());
    this.element.addEventListener("focusout", () => this.resetSelectionOnFocusOut());
  }

  setRegistry(registry) {
    this.clearSymbolRefresh();
    this.registryDisposable?.dispose();
    this.registryDisposable = null;
    this.registry = registry;
    this.symbolRequests = new WeakMap();
    this.editorSymbolsList = new WeakMap();

    if (registry) {
      this.registryDisposable = registry.onDidInvalidateFileSymbols(({ editor }) => {
        if (editor) {
          this.symbolRequests.delete(editor);
          this.editorSymbolsList.delete(editor);
        } else {
          this.symbolRequests = new WeakMap();
          this.editorSymbolsList = new WeakMap();
        }
        if (!this.activeEditor) return;
        if (editor && editor !== this.activeEditor) return;
        if (this.selectedSymbol) {
          this.selectionBeforeRefresh = {
            editor: this.activeEditor,
            symbol: this.selectedSymbol,
          };
        }
        this.populateForEditor(this.activeEditor);
      });
    }

    if (!this.activeEditor) return;
    this.setSymbols(null);
    if (registry) this.populateForEditor(this.activeEditor);
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
    if (!items.length) return;

    let index = items.indexOf(this.selectedRef ?? this.currentRef);
    if (index === -1) index = delta > 0 ? -1 : 0;
    const newIndex = (index + delta + items.length) % items.length;

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
    this.focus();
    if (this.config?.visitEntriesOnKeyboardMovement) {
      this.moveEditorToSymbol(symbol, { focus: false });
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
    const element = this.getActionEntry();
    if (!element) return;
    this.setSelectedSymbol(this.symbolForElement(element));
    this.focus();
    if (this.setEntryCollapsed(element, true)) return;

    const parent = element.parentElement?.closest("li.outline-view-entry");
    if (!parent) return;
    this.setEntryCollapsed(parent, true);
    this.setSelectedSymbol(this.symbolForElement(parent));
  }

  expandSelectedEntry() {
    const element = this.getActionEntry();
    if (!element) return;
    this.setSelectedSymbol(this.symbolForElement(element));
    this.focus();
    this.setEntryCollapsed(element, false);
  }

  collapseEntry(element) {
    return this.setEntryCollapsed(element, !element.classList.contains("collapsed"));
  }

  setEntryCollapsed(element, collapsed) {
    const childrenGroup = element.querySelector(":scope > .list-tree");
    if (!childrenGroup || element.classList.contains("collapsed") === collapsed) return false;
    childrenGroup.classList.toggle("hidden", collapsed);
    element.classList.toggle("collapsed", collapsed);
    this.setCurrentSymbol(this.currentSymbol);
    if (this.selectedSymbol) this.setSelectedSymbol(this.selectedSymbol);
    return true;
  }

  activateSelectedEntry(options = {}) {
    const element = this.getActionEntry();
    if (!element) return;
    if (options.addCursor) this.focus();
    return this.activateSymbol(this.symbolForElement(element), options);
  }

  async activateSymbol(symbol, options = {}) {
    const editor = this.activeEditor;
    if (!symbol) return;
    if (options.clearSearch && !options.addCursor) await this.clearSearch();
    return this.moveEditorToSymbol(symbol, options, editor);
  }

  async moveEditorToSymbol(symbol, options = {}, editor = this.activeEditor) {
    if (!symbol || !editor || editor.isDestroyed() || this.destroyed) return;
    if (options.addCursor) {
      editor.addCursorAtBufferPosition(symbol.position);
      return;
    }
    const focus = options.focus !== false;
    if (focus) {
      const opened = await lumine.workspace.open(editor, { searchAllPanes: true });
      if (!opened || editor.isDestroyed() || this.destroyed) return;
    }
    editor.setCursorBufferPosition(symbol.position, { autoscroll: false });
    editor.scrollToCursorPosition({ center: true });
    if (focus) lumine.views.getView(editor).focus();
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
    let lastCursor = editor.getLastCursor();
    const updateLastCursor = () => {
      const cursor = editor.getLastCursor();
      if (cursor === lastCursor) return;
      lastCursor = cursor;
      this.setCurrentSymbol(this.getActiveSymbolForEditor(editor));
    };

    disposables.add(
      editor.onDidChangeGrammar(() => {
        this.clearSymbolRefresh();
        this.setSymbols(null, editor);
      }),
      editor.onDidChangeCursorPosition(({ cursor }) => {
        if (cursor !== editor.getLastCursor()) return;
        this.setCurrentSymbol(this.getActiveSymbolForEditor(editor));
      }),
      editor.onDidAddCursor(updateLastCursor),
      editor.onDidRemoveCursor(updateLastCursor),
    );
  }

  switchToEditor(editor) {
    this.clearSymbolRefresh();
    this.activeEditorDisposables?.dispose();
    this.selectionBeforeRefresh = null;
    this.setSelectedSymbol(null);
    this.setCurrentSymbol(null);

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
    this.clearSymbolRefresh();
    this.activeEditorDisposables?.dispose();
    this.selectionBeforeRefresh = null;
    this.activeEditorDisposables = null;
    this.setSelectedSymbol(null);
    this.setCurrentSymbol(null);
    this.activeEditor = null;
    this.setSymbols(null);
  }

  async populateForEditor(editor) {
    if (!editor || this.destroyed) return;
    const request = { registry: this.registry, grammar: editor.getGrammar() };
    this.symbolRequests.set(editor, request);
    if (editor === this.activeEditor) this.scheduleSymbolRefresh(editor, request);
    let bufferChanged = false;
    const changes = editor.getBuffer().onDidChangeText(() => {
      bufferChanged = true;
      this.editorSymbolsList.delete(editor);
    });
    let symbols;
    try {
      symbols = await this.getSymbols(editor);
    } finally {
      changes.dispose();
    }
    if (
      this.destroyed ||
      editor.isDestroyed() ||
      this.symbolRequests.get(editor) !== request ||
      this.registry !== request.registry
    )
      return;
    // An edit can cancel the hub request before its next invalidation. Its
    // ranges cannot replace the tree retained for the current grace period.
    if (bufferChanged || editor.getGrammar() !== request.grammar) return;
    this.clearSymbolRefresh(request);
    return this.setSymbols(symbols, editor);
  }

  clearSymbolRefresh(request) {
    if (!this.symbolRefresh || (request && this.symbolRefresh.request !== request)) return;
    clearTimeout(this.symbolRefresh.timer);
    this.symbolRefresh = null;
  }

  scheduleSymbolRefresh(editor, request) {
    this.clearSymbolRefresh();
    if (this.symbols === null) return;
    const refresh = { request, timer: null };
    this.symbolRefresh = refresh;
    refresh.timer = setTimeout(() => {
      if (this.symbolRefresh !== refresh) return;
      this.symbolRefresh = null;
      if (
        this.destroyed ||
        editor.isDestroyed() ||
        this.activeEditor !== editor ||
        this.symbolRequests.get(editor) !== request ||
        this.registry !== request.registry ||
        editor.getGrammar() !== request.grammar
      )
        return;
      if (this.selectedSymbol) {
        this.selectionBeforeRefresh = { editor, symbol: this.selectedSymbol };
      }
      this.setSymbols(null, editor, { preserveSelection: true });
    }, SYMBOL_REFRESH_GRACE_PERIOD);
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
    this.refs.scroller.focus();
  }

  resetSelectionOnFocusOut() {
    clearTimeout(this.selectionResetTimer);
    this.selectionResetTimer = setTimeout(() => {
      if (!this.destroyed && !this.isFocused()) {
        this.selectionBeforeRefresh = null;
        this.setSelectedSymbol(null);
      }
    }, 75);
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
    return this.update();
  }

  unfocus() {
    lumine.workspace.getCenter().getActivePane().activate();
  }

  setSymbols(symbols, editor, { preserveSelection = false } = {}) {
    const target = editor ?? this.activeEditor;
    if (target && symbols === null) this.editorSymbolsList.delete(target);
    if (editor && editor !== this.activeEditor) {
      // A current response may warm an editor that no longer has focus.
      if (symbols !== null) this.editorSymbolsList.set(editor, symbols);
      return Promise.resolve();
    }
    this.symbols = symbols;
    if (symbols === null) {
      if (!preserveSelection) this.selectionBeforeRefresh = null;
      this.setSelectedSymbol(null);
      this.setCurrentSymbol(null);
    }
    if (this.activeEditor && symbols !== null) {
      this.editorSymbolsList.set(this.activeEditor, symbols);
    }
    this.searchResults = this.filterSymbols(this.searchQuery);
    return this.update();
  }

  getActiveSymbolForEditor(editor, flatSymbols) {
    editor ??= this.activeEditor;
    if (!editor) return null;

    const position = editor.getLastCursor()?.getBufferPosition();
    if (!position) return null;
    const allSymbols = flatSymbols ?? this.getFlatSymbols();

    let candidate = null;
    let sameRow = null;
    for (const symbol of allSymbols) {
      const range = symbol.range;
      if (range.containsPoint(position)) {
        // Parents precede their descendants. Prefer the innermost containing
        // range, including children that begin at the same position.
        if (!candidate || candidate.range.containsRange(range)) candidate = symbol;
      } else if (!sameRow && (range.start.row === position.row || range.end.row === position.row)) {
        sameRow = symbol;
      }
    }

    return candidate ?? sameRow;
  }

  setCurrentSymbol(symbol, { scroll = true } = {}) {
    this.currentRef?.classList.remove("current");
    for (const entry of this.currentStackRefs) entry.classList.remove("stack");
    this.currentStackRefs = [];
    this.currentSymbol = symbol;
    this.currentRef = symbol ? this.getClosestVisibleElementForSymbol(symbol) : null;
    this.currentRef?.classList.add("current");
    for (
      let entry = this.currentRef;
      entry;
      entry = entry.parentElement?.closest("li.outline-view-entry")
    ) {
      entry.classList.add("stack");
      this.currentStackRefs.push(entry);
    }
    if (scroll && !this.selectedRef) this.scrollEntryIntoViewIfNeeded(this.currentRef);
  }

  setSelectedSymbol(newSymbol, { scroll = true } = {}) {
    this.selectedRef?.classList.remove("selected");
    this.selectedSymbol = null;
    this.selectedRef = null;

    if (!newSymbol) return;

    const newElement = this.getClosestVisibleElementForSymbol(newSymbol);
    if (!newElement) return;

    this.selectedSymbol = this.symbolForElement(newElement);
    this.selectedRef = newElement;
    this.selectedRef.classList.add("selected");
    if (scroll) this.scrollEntryIntoViewIfNeeded(this.selectedRef);
  }

  scrollEntryIntoViewIfNeeded(entry) {
    if (!entry) return;
    let element = entry;
    if (element.classList.contains("list-nested-item")) {
      element = element.querySelector(".list-item");
    }
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const container = this.refs.scroller;
    const containerRect = container.getBoundingClientRect();

    if (rect.bottom > containerRect.bottom || rect.top < containerRect.top) {
      container.scrollTop +=
        rect.top < containerRect.top
          ? rect.top - containerRect.top
          : rect.bottom - containerRect.bottom;
    }
  }

  getActionEntry() {
    return this.selectedRef ?? this.currentRef ?? this.getVisibleListItems()[0] ?? null;
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

    this.setCurrentSymbol(symbol);
    this.scrollEntryIntoViewIfNeeded(element);
  }

  async getSymbols(editor = this.activeEditor) {
    if (!editor || !this.registry) return null;
    return this.registry.getFileSymbolTree(editor);
  }

  update() {
    return etch.update(this).then(() => {
      if (this.destroyed) return;
      const previous =
        this.selectedSymbol ??
        (this.symbols !== null && this.selectionBeforeRefresh?.editor === this.activeEditor
          ? this.selectionBeforeRefresh.symbol
          : null);
      const selected =
        previous &&
        (this.elementForSymbol(previous)
          ? previous
          : this.getFlatSymbols().find(
              (symbol) =>
                symbol.name === previous.name &&
                symbol.position.isEqual(previous.position) &&
                symbol.providerId === previous.providerId &&
                symbol.providerName === previous.providerName,
            ));
      if (this.symbols !== null) this.selectionBeforeRefresh = null;
      this.setSelectedSymbol(selected, { scroll: false });
      this.setCurrentSymbol(this.getActiveSymbolForEditor(), { scroll: !this.selectedRef });
      this.updateIcons();
    });
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
          ? "Symbol information is unavailable."
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
      etch.dom("div", { className: "outline-scroller", ref: "scroller", tabIndex: -1 }, contents),
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
