const { Emitter, Point, Range } = require("lumine");

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
  let mainModule, editor, view, providerDisposable;

  function names() {
    return Array.from(view.element.querySelectorAll(".name-inner")).map((el) => el.textContent);
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
    await lumine.packages.deactivatePackage("outline-view");
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

    it("reports an unsupported grammar using the navigation-panel message style", async () => {
      const message = await openEmptyView();

      expect(message.querySelector("ul").classList.contains("centered")).toBe(true);
      expect(message.textContent).toBe("This grammar is not supported");
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

      // Icons are derived from the provider's `kind` values.
      const alphaName = view.element.querySelector(".name-inner");
      expect(alphaName.parentNode.classList.contains("icon-gear")).toBe(true);
    });

    it("moves the cursor to a symbol when its entry is clicked", () => {
      const gammaInner = Array.from(view.element.querySelectorAll(".name-inner")).find(
        (el) => el.textContent === "gamma",
      );
      gammaInner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(editor.getCursorBufferPosition().isEqual([4, 2])).toBe(true);
    });

    it("tracks the cursor and confirms the selected entry", async () => {
      editor.setCursorBufferPosition([4, 3]);
      await waitForFrames(() => view.element.querySelector("li.selected"), {
        description: "the active outline entry to be selected",
      });
      const selected = view.element.querySelector("li.selected");
      expect(selected.querySelector(".name-inner").textContent).toBe("gamma");

      lumine.commands.dispatch(view.element, "outline-view:activate-selected-entry");
      expect(editor.getCursorBufferPosition().isEqual([4, 2])).toBe(true);
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
});
