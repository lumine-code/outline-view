describe("outline reveal availability", () => {
  it("requires a captured document editor without opening the view", async () => {
    const main = (await lumine.packages.activatePackage("outline-view")).mainModule;
    const available = () =>
      lumine.commands.canDispatch(
        lumine.workspace.getElement(),
        "outline-view:reveal-in-outline-view",
      );
    expect(available()).toBe(false);
    const editor = await lumine.workspace.open();
    expect(available()).toBe(true);
    expect(main.outlineView).toBe(null);
    editor.destroy();
    expect(available()).toBe(false);
    await lumine.packages.deactivatePackage("outline-view");
  });
  it("reveals the invoking window's document and rejects an empty auxiliary window", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    const main = (await lumine.packages.activatePackage("outline-view")).mainModule;
    const first = await lumine.workspace.open();
    const extra = await lumine.workspace.openEditorWindow({ show: false });
    const second = lumine.workspace.buildTextEditor();
    extra.getEditorContainer().getActivePane().activateItem(second, { activatePane: true });
    const reveal = jasmine.createSpy("reveal captured editor");
    spyOn(main, "getOutlineView").and.returnValue({ revealInOutlineView: reveal });
    try {
      await lumine.commands.dispatch(second.getElement(), "outline-view:reveal-in-outline-view");
      expect(reveal).toHaveBeenCalledOnceWith(second);
      expect(first.isDestroyed()).toBe(false);
      second.destroy();
      expect(
        lumine.commands.canDispatch(extra.getElement(), "outline-view:reveal-in-outline-view"),
      ).toBe(false);
      expect(
        main.commandEditor({ context: { editor: null, embeddedEditor: null, window: extra } }),
      ).toBe(null);
    } finally {
      first.destroy();
      await lumine.workspace.discardEditorWindows();
      await lumine.packages.deactivatePackage("outline-view");
    }
  });
});
