const { Point } = require("atom");

// A stub provider following the `outline-view` service contract (see
// ide-client's outline provider): `grammarScopes` is a getter, and
// `startPosition`/`endPosition` are point-compatible `[row, column]` arrays.
function makeOutlineProvider() {
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
  };
}

// A stub provider following the `symbol.provider` service contract, as
// provided by symbol-provider-tree-sitter and symbol-provider-ctags.
function makeSymbolProvider() {
  return {
    name: "Stub Symbols",
    packageName: "stub-symbols",
    isExclusive: true,
    canProvideSymbols: () => true,
    getSymbols: () => [
      { name: "delta", position: new Point(1, 0), tag: "function" },
      { name: "epsilon", position: new Point(2, 1), tag: "method", context: "delta" },
    ],
  };
}

function waitFor(condition, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      let value;
      try {
        value = condition();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
      } else if (Date.now() - start > timeout) {
        reject(new Error("Timed out waiting for condition"));
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  });
}

describe("outline-view", () => {
  let mainModule, editor, view, providerDisposable;

  function names() {
    return Array.from(view.element.querySelectorAll(".name-inner")).map((el) => el.textContent);
  }

  async function openEditorAndView() {
    editor = await atom.workspace.open();
    editor.setText(Array(12).fill("// line").join("\n"));
    view = mainModule.getOutlineView();
    await view.show();
    await waitFor(() => view.element.querySelector("li.outline-view-entry"));
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(atom.views.getView(atom.workspace));
    const pack = await atom.packages.activatePackage("outline-view");
    mainModule = pack.mainModule;
  });

  afterEach(async () => {
    providerDisposable?.dispose();
    providerDisposable = null;
    await atom.packages.deactivatePackage("outline-view");
  });

  describe("with an outline-view provider", () => {
    beforeEach(async () => {
      providerDisposable = mainModule.consumeOutline(makeOutlineProvider());
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
      const selected = await waitFor(() => view.element.querySelector("li.selected"));
      expect(selected.querySelector(".name-inner").textContent).toBe("gamma");

      atom.commands.dispatch(view.element, "outline-view:activate-selected-entry");
      expect(editor.getCursorBufferPosition().isEqual([4, 2])).toBe(true);
    });

    it("hides ignored symbol kinds and their descendants", async () => {
      atom.config.set("outline-view.ignoredSymbolTypes", ["class"]);
      await waitFor(() => names().length === 1);
      expect(names()).toEqual(["alpha"]);
    });
  });

  describe("with only a symbol.provider fallback", () => {
    beforeEach(async () => {
      providerDisposable = mainModule.consumeSymbol(makeSymbolProvider());
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
  });
});
