const { Emitter, Icon, Point, Range } = require("lumine");

// A stub following the `symbol.registry` service contract, as provided by
// the symbol hub: the hierarchy and normalized locations are already cached.
function makeSymbolRegistry() {
  const emitter = new Emitter();
  return {
    symbols: [
      {
        name: "alpha",
        position: new Point(0, 0),
        range: new Range([0, 0], [2, 0]),
        tag: "function",
        children: [],
      },
      {
        name: "Beta",
        position: new Point(3, 0),
        range: new Range([3, 0], [9, 0]),
        tag: "class",
        children: [
          {
            name: "gamma",
            position: new Point(4, 2),
            range: new Range([4, 2], [6, 0]),
            tag: "method",
            children: [],
          },
        ],
      },
    ],
    async getFileSymbolTree() {
      return this.symbols;
    },
    peekFileSymbolTree() {
      return this.symbols;
    },
    onDidInvalidateFileSymbols(callback) {
      return emitter.on("did-invalidate-file-symbols", callback);
    },
    invalidate(bundle = { editor: null, provider: null }) {
      emitter.emit("did-invalidate-file-symbols", bundle);
    },
  };
}

describe("outline-view", () => {
  let mainModule, editor, view, providerDisposable, iconRegistration;

  function names() {
    return Array.from(view.element.querySelectorAll(".name-inner")).map((el) => el.textContent);
  }

  function entryNamed(name) {
    return Array.from(view.element.querySelectorAll(".name-inner"))
      .find((element) => element.textContent === name)
      ?.closest("li.outline-view-entry");
  }

  function selectedName() {
    return view.element.querySelector("li.selected .name-inner")?.textContent;
  }

  function pressKey(key, target = document.activeElement, options = {}) {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    Object.defineProperty(event, "target", { get: () => target });
    Object.defineProperty(event, "path", { get: () => [target] });
    lumine.keymaps.handleKeyboardEvent(event);
  }

  async function waitForEditorFocus(position) {
    await waitForFrames(
      () =>
        editor.getCursorBufferPosition().isEqual(position) &&
        lumine.views.getView(editor).contains(document.activeElement),
      { description: "the outline navigation to move and focus the editor" },
    );
  }

  async function openEditorAndView() {
    editor = await lumine.workspace.open();
    editor.setText(Array(12).fill("// line").join("\n"));
    view = mainModule.getOutlineView();
    await view.show();
    await waitForFrames(() => view.element.querySelector("li.outline-view-entry"), {
      description: "the outline to render its first entry",
    });
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    const pack = await lumine.packages.activatePackage("outline-view");
    mainModule = pack.mainModule;
  });

  afterEach(async () => {
    providerDisposable?.dispose();
    providerDisposable = null;
    iconRegistration?.dispose();
    iconRegistration = null;
    await lumine.packages.deactivatePackage("outline-view");
  });

  it("puts the configured default side first", () => {
    view = mainModule.getOutlineView();
    lumine.config.set("outline-view.showOnRightSide", false);
    expect(view.getDefaultLocation()).toBe("left");
    expect(view.getAllowedLocations()).toEqual(["left", "right"]);

    lumine.config.set("outline-view.showOnRightSide", true);
    expect(view.getDefaultLocation()).toBe("right");
    expect(view.getAllowedLocations()).toEqual(["right", "left"]);
  });

  describe("workspace serialization", () => {
    it("restores one view and wires a symbol registry delivered later", async () => {
      await lumine.packages.deactivatePackage("outline-view");
      const pack = lumine.packages.getLoadedPackage("outline-view");
      mainModule = pack.mainModule;
      const activate = spyOn(mainModule, "activate").and.callThrough();
      const initialActivation = spyOn(
        lumine.packages,
        "hasActivatedInitialPackages",
      ).and.returnValue(false);
      const state = { deserializer: "outline-view/OutlineView" };
      view = lumine.deserializers.deserialize(state);

      expect(view.serialize()).toEqual(state);
      expect(mainModule.getOutlineView()).toBe(view);
      expect(lumine.deserializers.deserialize(view.serialize())).toBe(view);
      expect(activate).not.toHaveBeenCalled();

      initialActivation.and.callThrough();
      await lumine.packages.activatePackage("outline-view");
      expect(activate.calls.count()).toBe(1);
      expect(mainModule.getOutlineView()).toBe(view);

      const registry = makeSymbolRegistry();
      providerDisposable = mainModule.consumeSymbolRegistry(registry);
      editor = await lumine.workspace.open();
      editor.setText(Array(12).fill("// line").join("\n"));
      registry.invalidate({ editor });
      await view.show();
      await waitForFrames(() => view.element.querySelector("li.outline-view-entry"), {
        description: "the restored outline to receive symbols",
      });
      expect(names()).toEqual(["alpha", "Beta", "gamma"]);

      await lumine.workspace.paneForItem(view).destroyItem(view);
      expect(mainModule.outlineView).toBeNull();
      const reopened = lumine.deserializers.deserialize(state);
      expect(reopened).not.toBe(view);
      expect(mainModule.getOutlineView()).toBe(reopened);
    });
  });

  describe("empty states", () => {
    async function openEmptyView() {
      editor = await lumine.workspace.open();
      view = mainModule.getOutlineView();
      await view.show();
      await waitForFrames(() => view.element.querySelector("background-tips li"), {
        description: "the outline empty state to render",
      });
      return view.element.querySelector("background-tips");
    }

    it("reports unavailable symbols using the navigation-panel message style", async () => {
      const message = await openEmptyView();

      expect(message.querySelector("ul").classList.contains("centered")).toBe(true);
      expect(message.textContent).toBe("Symbol information is unavailable.");
    });

    it("reports a supported editor with no symbols", async () => {
      const registry = makeSymbolRegistry();
      registry.symbols = [];
      providerDisposable = mainModule.consumeSymbolRegistry(registry);

      const message = await openEmptyView();

      expect(message.textContent).toBe("No symbols");
    });
  });

  describe("with symbol.registry", () => {
    let registry;

    beforeEach(async () => {
      registry = makeSymbolRegistry();
      providerDisposable = mainModule.consumeSymbolRegistry(registry);
      await openEditorAndView();
    });

    it("renders the outline as a nested tree in the dock item", () => {
      expect(view.element.querySelectorAll("li.outline-view-entry").length).toBe(3);
      expect(names()).toEqual(["alpha", "Beta", "gamma"]);

      // `Beta` has children, so it renders as a nested item with a sub-list.
      const nested = view.element.querySelector("li.list-nested-item");
      expect(nested.querySelector(".name-inner").textContent).toBe("Beta");
      expect(nested.querySelectorAll("ul.outline-list li.outline-view-entry").length).toBe(1);

      // Icons are derived from symbol tags through the shared icon registry.
      const alphaName = view.element.querySelector(".name-inner");
      const alphaIcon = alphaName.parentNode.querySelector(".outline-symbol-icon");
      expect(alphaIcon.classList).toContain("icon");
      expect(alphaIcon.classList).toContain("icon-gear");
    });

    it("uses and live-updates the shared kind icon registry", async () => {
      const beta = Array.from(view.element.querySelectorAll(".name-inner")).find(
        (element) => element.textContent === "Beta",
      );
      expect(beta.parentNode.querySelector(".outline-symbol-icon").classList).toContain(
        "icon-puzzle",
      );

      iconRegistration = lumine.icons.addProvider(
        {
          id: "outline-view-spec",
          handles: ["kind"],
          usesContext: true,
          iconFor(target) {
            return target.context === "outline-view" && target.kind === "class"
              ? Icon.classes(["icon-flame"])
              : null;
          },
        },
        { priority: 100 },
      );
      await waitForFrames(() => beta.parentNode.querySelector(".outline-symbol-icon.icon-flame"), {
        description: "the outline icon to repaint from the shared provider",
      });

      iconRegistration.dispose();
      iconRegistration = null;
      await waitForFrames(() => beta.parentNode.querySelector(".outline-symbol-icon.icon-puzzle"), {
        description: "the outline icon to return to the core kind mapping",
      });
    });

    it("routes an explicit symbol icon through the shared name registry", async () => {
      registry.symbols[0].icon = "flame";
      registry.invalidate({ editor, provider: null });
      await waitForFrames(
        () =>
          Array.from(view.element.querySelectorAll(".name-inner"))
            .find((element) => element.textContent === "alpha")
            ?.parentNode.querySelector(".outline-symbol-icon.icon-flame"),
        { description: "the explicit symbol icon to render" },
      );

      iconRegistration = lumine.icons.addProvider(
        {
          id: "outline-view-explicit-spec",
          handles: ["name"],
          usesContext: true,
          iconFor(target) {
            return target.context === "outline-view" && target.name === "flame"
              ? Icon.classes(["icon-star"])
              : null;
          },
        },
        { priority: 100 },
      );
      await waitForFrames(
        () =>
          Array.from(view.element.querySelectorAll(".name-inner"))
            .find((element) => element.textContent === "alpha")
            ?.parentNode.querySelector(".outline-symbol-icon.icon-star"),
        { description: "the explicit icon to repaint from the shared provider" },
      );
    });

    it("moves and focuses the editor when a symbol entry is clicked", async () => {
      view.focus();
      expect(document.activeElement).toBe(view.refs.scroller);

      entryNamed("gamma")
        .querySelector(".name-inner")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await waitForEditorFocus([4, 2]);

      expect(editor.getCursorBufferPosition().isEqual([4, 2])).toBe(true);
      expect(lumine.workspace.getActivePaneContainer()).toBe(lumine.workspace.getCenter());
    });

    it("tracks the cursor and confirms the selected entry", async () => {
      editor.setCursorBufferPosition([4, 3]);
      await waitForFrames(() => view.element.querySelector("li.selected"), {
        description: "the active outline entry to be selected",
      });
      const selected = view.element.querySelector("li.selected");
      expect(selected.querySelector(".name-inner").textContent).toBe("gamma");

      lumine.commands.dispatch(view.element, "outline-view:activate-selected-entry");
      await waitForEditorFocus([4, 2]);
      expect(editor.getCursorBufferPosition().isEqual([4, 2])).toBe(true);
    });

    describe("panel keyboard navigation", () => {
      beforeEach(() => {
        lumine.keymaps.loadBundledKeymaps();
        editor.setCursorBufferPosition([0, 0]);
        view.focus();
      });

      it("wraps through visible symbols while keeping focus in the list", () => {
        const initialPosition = editor.getCursorBufferPosition();
        view.setSelectedSymbol(null);
        view.focus();
        expect(selectedName()).toBe("alpha");
        expect(document.activeElement).toBe(view.refs.scroller);

        pressKey("ArrowUp");
        expect(selectedName()).toBe("gamma");
        pressKey("ArrowDown");
        expect(selectedName()).toBe("alpha");
        pressKey("ArrowDown");
        expect(selectedName()).toBe("Beta");
        pressKey("ArrowLeft");
        expect(entryNamed("Beta").classList.contains("collapsed")).toBe(true);
        pressKey("ArrowDown");
        expect(selectedName()).toBe("alpha");
        pressKey("ArrowUp");
        expect(selectedName()).toBe("Beta");

        expect(editor.getCursorBufferPosition()).toEqual(initialPosition);
        expect(document.activeElement).toBe(view.refs.scroller);
      });

      it("collapses with Left, expands with Right, and collapses a leaf's parent", () => {
        pressKey("ArrowDown");
        pressKey("ArrowLeft");
        expect(entryNamed("Beta").classList.contains("collapsed")).toBe(true);
        pressKey("ArrowLeft");
        expect(entryNamed("Beta").classList.contains("collapsed")).toBe(true);
        pressKey("ArrowRight");
        expect(entryNamed("Beta").classList.contains("collapsed")).toBe(false);
        pressKey("ArrowRight");
        expect(selectedName()).toBe("Beta");
        pressKey("ArrowDown");
        expect(selectedName()).toBe("gamma");
        pressKey("ArrowLeft");
        expect(selectedName()).toBe("Beta");
        expect(entryNamed("Beta").classList.contains("collapsed")).toBe(true);
        expect(document.activeElement).toBe(view.refs.scroller);
      });

      it("selects and collapses the parent of an already collapsed branch", async () => {
        registry.symbols[1].children[0].children = [
          {
            name: "delta",
            position: new Point(5, 4),
            range: new Range([5, 4], [5, 8]),
            tag: "variable",
            children: [],
          },
        ];
        registry.invalidate({ editor });
        await waitForFrames(() => names().includes("delta"), {
          description: "the nested branch to render",
        });
        view.setSelectedSymbol(registry.symbols[1].children[0]);
        view.focus();

        pressKey("ArrowLeft");
        expect(selectedName()).toBe("gamma");
        expect(entryNamed("gamma").classList.contains("collapsed")).toBe(true);
        pressKey("ArrowLeft");
        expect(selectedName()).toBe("Beta");
        expect(entryNamed("Beta").classList.contains("collapsed")).toBe(true);
      });

      it("confirms with Enter and focuses the editor", async () => {
        pressKey("ArrowDown");
        pressKey("ArrowDown");
        pressKey("Enter");

        await waitForEditorFocus([4, 2]);
        expect(editor.getCursorBufferPosition().isEqual([4, 2])).toBe(true);
      });

      it("previews keyboard selections without taking focus from the list", async () => {
        lumine.config.set("outline-view.visitEntriesOnKeyboardMovement", true);
        view.focusSearch();
        view.setSelectedSymbol(null);
        editor.setCursorBufferPosition([11, 0]);
        view.focus();
        expect(selectedName()).toBe("alpha");
        expect(editor.getCursorBufferPosition().isEqual([11, 0])).toBe(true);

        pressKey("ArrowDown");
        await waitForFrames(() => editor.getCursorBufferPosition().isEqual([3, 0]), {
          description: "the keyboard selection to preview its symbol",
        });

        expect(selectedName()).toBe("Beta");
        expect(document.activeElement).toBe(view.refs.scroller);
      });

      it("uses Tab to switch focus and Escape to clear search from either surface", async () => {
        pressKey("Tab");
        expect(view.refs.searchEditor.element.contains(document.activeElement)).toBe(true);
        view.refs.searchEditor.setText("gm");
        await waitForFrames(() => names().length === 1, {
          description: "the search to filter symbols",
        });
        pressKey("Escape");
        await waitForFrames(() => names().length === 3, {
          description: "Escape in search to restore the full outline",
        });
        expect(view.refs.searchEditor.getText()).toBe("");
        expect(view.refs.searchEditor.element.contains(document.activeElement)).toBe(true);

        view.refs.searchEditor.setText("gm");
        await waitForFrames(() => names().length === 1, {
          description: "the search to filter symbols again",
        });
        pressKey("Tab");
        expect(document.activeElement).toBe(view.refs.scroller);
        pressKey("Escape");
        await waitForFrames(() => names().length === 3, {
          description: "Escape in the list to restore the full outline",
        });
        expect(view.refs.searchEditor.getText()).toBe("");
        expect(document.activeElement).toBe(view.refs.scroller);
      });

      it("keeps Left, Right, Home, and End local to the focused search editor", async () => {
        view.setSelectedSymbol(registry.symbols[1]);
        view.focusSearch();
        const searchEditor = view.refs.searchEditor;
        searchEditor.setText("a");
        await waitForFrames(() => view.searchResults?.length === 3 && names().length === 3, {
          description: "the query to render symbols before editing it",
        });
        view.setSelectedSymbol(registry.symbols[1]);
        searchEditor.setCursorBufferPosition([0, 1]);

        pressKey("ArrowLeft");
        expect(searchEditor.getCursorBufferPosition().isEqual([0, 0])).toBe(true);
        pressKey("ArrowRight");
        expect(searchEditor.getCursorBufferPosition().isEqual([0, 1])).toBe(true);
        pressKey("Home");
        expect(searchEditor.getCursorBufferPosition().isEqual([0, 0])).toBe(true);
        pressKey("End");
        expect(searchEditor.getCursorBufferPosition().isEqual([0, 1])).toBe(true);

        expect(selectedName()).toBe("Beta");
        expect(entryNamed("Beta").classList.contains("collapsed")).toBe(false);
        expect(searchEditor.element.contains(document.activeElement)).toBe(true);
      });

      it("selects filtered entries with Up and Down while search keeps focus", async () => {
        view.focusSearch();
        view.refs.searchEditor.setText("a");
        await waitForFrames(() => view.searchResults?.length === 3 && names().length === 3, {
          description: "the query to render its symbol choices",
        });
        const choices = names();
        view.setSelectedSymbol(null);

        pressKey("ArrowDown");
        expect(selectedName()).toBe(choices[0]);
        pressKey("ArrowDown");
        expect(selectedName()).toBe(choices[1]);
        pressKey("ArrowUp");
        expect(selectedName()).toBe(choices[0]);
        pressKey("ArrowUp");
        expect(selectedName()).toBe(choices[2]);

        expect(editor.getCursorBufferPosition().isEqual([0, 0])).toBe(true);
        expect(view.refs.searchEditor.element.contains(document.activeElement)).toBe(true);
      });

      it("keeps the source editor when it changes while Alt navigation clears search", async () => {
        view.setSelectedSymbol(registry.symbols[1].children[0]);
        let completeClearSearch;
        spyOn(view, "clearSearch").and.returnValue(
          new Promise((resolve) => {
            completeClearSearch = resolve;
          }),
        );
        const activate = spyOn(view, "activateSelectedEntry").and.callThrough();
        lumine.commands.dispatch(
          view.refs.scroller,
          "outline-view:activate-selected-entry-clear-search",
        );
        const navigation = activate.calls.mostRecent().returnValue;
        const nextEditor = await lumine.workspace.open();
        expect(view.activeEditor).toBe(nextEditor);

        completeClearSearch();
        await navigation;
        await waitForEditorFocus([4, 2]);

        expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(editor);
        expect(nextEditor.getCursorBufferPosition().isEqual([0, 0])).toBe(true);
      });

      for (const route of ["keyboard", "click"]) {
        it(`preserves search when opening a symbol by ${route}`, async () => {
          view.refs.searchEditor.setText("gm");
          await waitForFrames(() => names().length === 1, {
            description: "the symbol to become the only search result",
          });
          if (route === "keyboard") {
            view.focusSearch();
            pressKey("Enter");
          } else {
            view.focus();
            entryNamed("gamma")
              .querySelector(".name-inner")
              .dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }

          await waitForEditorFocus([4, 2]);
          expect(view.refs.searchEditor.getText()).toBe("gm");
          expect(names()).toEqual(["gamma"]);
        });

        it(`clears search and focuses the editor with Alt ${route}`, async () => {
          view.refs.searchEditor.setText("gm");
          await waitForFrames(() => names().length === 1, {
            description: "the symbol to become the only search result",
          });
          if (route === "keyboard") {
            view.focusSearch();
            pressKey("Enter", document.activeElement, { altKey: true });
          } else {
            view.focus();
            entryNamed("gamma")
              .querySelector(".name-inner")
              .dispatchEvent(new MouseEvent("click", { bubbles: true, altKey: true }));
          }

          await waitForEditorFocus([4, 2]);
          await waitForFrames(() => names().length === 3, {
            description: "Alt navigation to restore the full outline",
          });
          expect(view.refs.searchEditor.getText()).toBe("");
        });

        it(`adds a cursor and retains panel focus with Ctrl ${route}`, async () => {
          view.refs.searchEditor.setText("gm");
          await waitForFrames(() => names().length === 1, {
            description: "the symbol to become the only search result",
          });
          if (route === "keyboard") {
            view.focusSearch();
            pressKey("Enter", document.activeElement, { ctrlKey: true });
          } else {
            view.focus();
            entryNamed("gamma")
              .querySelector(".name-inner")
              .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
          }

          expect(editor.getCursorBufferPositions().map((point) => point.toArray())).toEqual([
            [0, 0],
            [4, 2],
          ]);
          expect(view.refs.searchEditor.getText()).toBe("gm");
          if (route === "keyboard") {
            expect(view.refs.searchEditor.element.contains(document.activeElement)).toBe(true);
          } else {
            expect(document.activeElement).toBe(view.refs.scroller);
          }
        });
      }
    });

    it("refreshes when the registry invalidates the active editor", async () => {
      registry.symbols = [
        {
          name: "ready",
          position: new Point(1, 0),
          range: new Range([1, 0], [2, 0]),
          tag: "function",
          children: [],
        },
      ];

      registry.invalidate({ editor, provider: null });

      await waitForFrames(() => names().length === 1 && names()[0] === "ready", {
        description: "the invalidated registry result to render",
      });
    });

    it("follows the workspace center while the outline dock has focus", async () => {
      const center = lumine.workspace.getCenter();
      expect(lumine.workspace.getActivePaneContainer()).not.toBe(center);

      const nextEditor = lumine.workspace.buildTextEditor();
      center.getActivePane().addItem(nextEditor);
      center.getActivePane().activateItem(nextEditor);

      expect(lumine.workspace.getActivePaneContainer()).not.toBe(center);
      expect(view.activeEditor).toBe(nextEditor);

      const plainItem = {
        element: document.createElement("div"),
        getTitle: () => "Plain",
      };
      center.getActivePane().addItem(plainItem);
      center.getActivePane().activateItem(plainItem);

      expect(view.activeEditor).toBeNull();
      await waitForFrames(() => names().length === 0, {
        description: "the outline to clear for a non-editor center item",
      });
    });

    it("resolves the active symbol once when multiple cursors move", () => {
      editor.setSelectedBufferRanges([
        [
          [0, 1],
          [0, 1],
        ],
        [
          [4, 3],
          [4, 3],
        ],
        [
          [8, 1],
          [8, 1],
        ],
      ]);
      const getActiveSymbol = spyOn(view, "getActiveSymbolForEditor").and.callThrough();

      editor.selectRight();

      expect(getActiveSymbol.calls.count()).toBe(1);
    });

    it("hides ignored symbol kinds and their descendants", async () => {
      lumine.config.set("outline-view.ignoredSymbolTypes", ["class"]);
      await waitForFrames(() => names().length === 1, {
        description: "ignored symbols to disappear from the outline",
      });
      expect(names()).toEqual(["alpha"]);
    });

    it("filters symbols from the search panel and clears the query", async () => {
      expect(view.refs.searchEditor.getPlaceholderText()).toBe("Search...");

      view.refs.searchEditor.setText("gm");
      await waitForFrames(() => names().length === 1, {
        description: "the outline search results to render",
      });
      expect(names()).toEqual(["gamma"]);
      expect(view.element.querySelectorAll(".character-match").length).toBe(2);

      lumine.commands.dispatch(view.refs.searchEditor.element, "outline-view:clear-search");
      await waitForFrames(() => names().length === 3, {
        description: "the full outline to return after clearing the search",
      });
      expect(view.refs.searchEditor.getText()).toBe("");
      expect(names()).toEqual(["alpha", "Beta", "gamma"]);
    });
  });
  describe("asynchronous symbol generations", () => {
    let registry;

    beforeEach(async () => {
      registry = makeSymbolRegistry();
      providerDisposable = mainModule.consumeSymbolRegistry(registry);
      await openEditorAndView();
    });

    it("clears current unavailable results and selection while preserving empty results", async () => {
      editor.setCursorBufferPosition([4, 3]);
      expect(view.getSelectedSymbol()).not.toBeNull();
      registry.symbols = null;
      registry.invalidate();
      await waitForFrames(() => names().length === 0, {
        description: "unavailable results to clear the old outline",
      });
      expect(view.getSelectedSymbol()).toBeNull();
      expect(view.element.querySelector("background-tips").textContent).toBe(
        "Symbol information is unavailable.",
      );
      expect(view.editorSymbolsList.has(editor)).toBe(false);
      registry.symbols = [];
      registry.invalidate();
      await waitForFrames(
        () => view.element.querySelector("background-tips").textContent === "No symbols",
        {
          description: "a valid empty result to show No symbols",
        },
      );
    });

    it("ignores a superseded null response after a newer tree arrives", async () => {
      const pending = [];
      registry.getFileSymbolTree = () => new Promise((resolve) => pending.push(resolve));
      const previous = view.populateForEditor(editor);
      const current = view.populateForEditor(editor);
      pending[1](registry.symbols);
      await current;
      pending[0](null);
      await previous;
      expect(names()).toEqual(["alpha", "Beta", "gamma"]);
      expect(view.symbols).toBe(registry.symbols);
    });

    it("discards ranges returned after the buffer changed during a request", async () => {
      let complete;
      registry.getFileSymbolTree = () => new Promise((resolve) => (complete = resolve));
      const pending = view.populateForEditor(editor);
      editor.insertText("\n");
      complete(registry.symbols);
      await pending;
      expect(names()).toEqual([]);
      expect(view.symbols).toBeNull();
      expect(view.editorSymbolsList.has(editor)).toBe(false);
    });
  });
});
