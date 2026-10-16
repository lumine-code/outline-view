describe("outline reveal availability", () => {
  it("requires the authored active-center editor without opening the view", async () => {
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
});
