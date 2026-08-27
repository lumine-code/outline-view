const { Emitter, Point } = require("lumine");

// A stub provider following the `outline-view` service contract (see
// ide-client's outline provider): `grammarScopes` is a getter, and
// `startPosition`/`endPosition` are point-compatible `[row, column]` arrays.
function makeOutlineProvider() {
  const emitter = new Emitter();
  return {
    name: "Stub Outline",
    priority: 2,
    updateOnEdit: true,
    get grammarScopes() {
      return ["text.plain.null-grammar"];
    },
    async getOutline() {
      return {
        outlineTrees: [
          {
            kind: "function",
            plainText: "alpha",
            representativeName: "alpha",
            startPosition: [0, 0],
            endPosition: [2, 0],
            children: [],
          },
          {
            kind: "class",
            plainText: "Beta",
            representativeName: "Beta",
            startPosition: [3, 0],
            endPosition: [9, 0],
            children: [
              {
                kind: "method",
                plainText: "gamma",
                representativeName: "gamma",
                startPosition: [4, 2],
                endPosition: [6, 0],
                children: [],
              },
            ],
          },
        ],
      };
    },
    onDidInvalidate(callback) {
      return emitter.on("did-invalidate", callback);
    },
    invalidate(bundle = { editor: null }) {
      emitter.emit("did-invalidate", bundle);
    },
  };
}

// A stub following the `symbol.registry` service contract, as provided by
// the symbol hub: symbols arrive pre-sorted, each carrying a `position`.
function makeSymbolRegistry() {
  const emitter = new Emitter();
  return {
    symbols: [
      { name: "delta", position: new Point(1, 0), tag: "function" },
      { name: "epsilon", position: new Point(2, 1), tag: "method", context: "delta" },
    ],
    async getFileSymbols() {
      return this.symbols;
    },
    peekFileSymbols() {
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
      const provider = makeOutlineProvider();
      provider.getOutline = async () => ({ outlineTrees: [] });
      providerDisposable = mainModule.consumeOutline(provider);

      const message = await openEmptyView();

      expect(message.textContent).toBe("No symbols");
    });
  });

  describe("with an outline-view provider", () => {
    let outlineProvider;

    beforeEach(async () => {
      outlineProvider = makeOutlineProvider();
      providerDisposable = mainModule.consumeOutline(outlineProvider);
      await openEditorAndView();
    });

    afterEach(() => {
      outlineProvider = null;
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

    it("refreshes when the active provider becomes ready", async () => {
      outlineProvider.getOutline = async () => ({
        outlineTrees: [
          {
            kind: "function",
            plainText: "ready",
            startPosition: [1, 0],
            endPosition: [2, 0],
          },
        ],
      });

      outlineProvider.invalidate({ editor });

      await waitForFrames(() => names().length === 1 && names()[0] === "ready", {
        description: "the outline provider's ready result to render",
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

  describe("with only the symbol.registry fallback", () => {
    let registry;

    beforeEach(async () => {
      registry = makeSymbolRegistry();
      providerDisposable = mainModule.consumeSymbolRegistry(registry);
      await openEditorAndView();
    });

    it("assembles symbols into an outline, nesting entries by context", () => {
      expect(names()).toEqual(["delta", "epsilon"]);

      // `epsilon` declares `delta` as its context, so it nests under it.
      const nested = view.element.querySelector("li.list-nested-item");
      expect(nested.querySelector(".name-inner").textContent).toBe("delta");
      expect(nested.querySelectorAll("li.outline-view-entry").length).toBe(1);

      // Symbol tags map to both `kind` and the icon.
      const deltaName = nested.querySelector(".name");
      expect(deltaName.classList.contains("icon-gear")).toBe(true);
    });

    it("moves the cursor when a fallback entry is clicked", () => {
      const epsilonInner = Array.from(view.element.querySelectorAll(".name-inner")).find(
        (el) => el.textContent === "epsilon",
      );
      epsilonInner.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(editor.getCursorBufferPosition().isEqual([2, 1])).toBe(true);
    });

    it("refreshes when the registry announces an invalidation", async () => {
      registry.symbols = [{ name: "zeta", position: new Point(3, 0), tag: "function" }];
      registry.invalidate({ editor, provider: null });
      await waitForFrames(() => names().length === 1, {
        description: "the invalidated outline to render",
      });
      expect(names()).toEqual(["zeta"]);
    });

    it("ignores invalidations scoped to another editor", async () => {
      registry.symbols = [{ name: "zeta", position: new Point(3, 0), tag: "function" }];
      registry.invalidate({ editor: {}, provider: null });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(names()).toEqual(["delta", "epsilon"]);
    });

    it("keeps the current outline when a run is superseded", async () => {
      registry.getFileSymbols = async () => null;
      registry.invalidate({ editor, provider: null });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(names()).toEqual(["delta", "epsilon"]);
    });

    it("removes the adapter when the service is torn down", () => {
      expect(mainModule.broker.providers.length).toBe(1);
      providerDisposable.dispose();
      providerDisposable = null;
      expect(mainModule.broker.providers.length).toBe(0);
      // A stale invalidation from the departed service must be inert.
      registry.invalidate({ editor, provider: null });
      expect(names()).toEqual(["delta", "epsilon"]);
    });
  });
});
