const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(root, rel));

// Guards for the pulsar-outline-view -> outline-view rebrand and the
// TypeScript/Less -> plain CommonJS/CSS modernization. The command prefix,
// config namespace, CSS class root, and package name all move to
// `outline-view`; the consumed service names stay the same.
describe("outline-view package assets", () => {
  it("ships keymaps and menus as JSON, not CSON", () => {
    expect(exists("keymaps/outline-view.json")).toBe(true);
    expect(exists("menus/outline-view.json")).toBe(true);
    expect(exists("keymaps/pulsar-outline-view.json")).toBe(false);
    expect(exists("menus/pulsar-outline-view.json")).toBe(false);
    expect(exists("keymaps/outline-view.cson")).toBe(false);
    expect(exists("menus/outline-view.cson")).toBe(false);
  });

  it("uses the outline-view: command prefix in the keymap and menu", () => {
    const keymap = JSON.parse(read("keymaps/outline-view.json"));
    expect(keymap["atom-workspace"]["cmdorctrl-alt-o"]).toBe("outline-view:toggle");
    expect(keymap[".outline-view"]["enter"]).toBe("outline-view:activate-selected-entry");
    expect(read("keymaps/outline-view.json")).not.toContain("pulsar-outline-view:");

    const menu = JSON.parse(read("menus/outline-view.json"));
    const flat = JSON.stringify(menu);
    expect(flat).toContain("outline-view:toggle");
    expect(flat).not.toContain("pulsar-outline-view");
    // Menu entries must use the singular `command` key.
    expect(flat).not.toContain('"commands"');
  });

  it("ships a CSS stylesheet built on custom properties, not Less", () => {
    expect(exists("styles/outline-view.css")).toBe(true);
    expect(exists("styles/pulsar-outline-view.less")).toBe(false);
    expect(exists("styles/outline-view.less")).toBe(false);
    const css = read("styles/outline-view.css");
    expect(css).toContain(".outline-view");
    expect(css).toContain("var(--");
    expect(css).not.toContain("pulsar-outline-view");
    expect(css).not.toContain('@import "ui-variables"');
    expect(css).not.toMatch(/\bfade\(|\bcontrast\(|\blighten\(|\bdarken\(|@[a-z-]+:/);
  });

  it("is named `outline-view`, scopes its dependencies, and drops the build step", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.name).toBe("outline-view");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/outline-view");
    expect(pkg.bugs.url).toBe("https://github.com/lumine-code/outline-view/issues");
    expect(pkg.main).toBe("./lib/main");
    expect(pkg.dependencies["@lumine-code/etch"]).toBeDefined();
    expect(pkg.dependencies.etch).toBeUndefined();
    expect(pkg.dependencies.classnames).toBeUndefined();
    expect(pkg.devDependencies.typescript).toBeUndefined();
    expect(exists("tsconfig.json")).toBe(false);
    expect(exists("dist")).toBe(false);
  });

  it("consumes the outline-view and symbol.provider services", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.consumedServices["outline.provider"].versions["^1.0.0"]).toBe("consumeOutline");
    expect(pkg.consumedServices["symbol.provider"].versions["^1.0.0"]).toBe("consumeSymbol");
    expect(pkg.providedServices).toBeUndefined();
  });

  it("defines the config schema under the outline-view namespace without order keys", () => {
    const pkg = JSON.parse(read("package.json"));
    const schema = pkg.configSchema;
    expect(Object.keys(schema).sort()).toEqual([
      "ignoredSymbolTypes",
      "nameOverflowStrategy",
      "showOnRightSide",
      "visitEntriesOnKeyboardMovement",
    ]);
    for (const entry of Object.values(schema)) {
      expect(entry.order).toBeUndefined();
      expect(entry.title).toBeDefined();
      expect(entry.description).toBeDefined();
      expect(entry.type).toBeDefined();
      // `default` must be the last key of every entry.
      const keys = Object.keys(entry);
      expect(keys[keys.length - 1]).toBe("default");
    }
  });

  it("keeps the README description in sync with package.json", () => {
    const pkg = JSON.parse(read("package.json"));
    const lines = read("README.md").split(/\r?\n/);
    expect(lines[0]).toBe("# outline-view");
    const sentence = lines.find((line, index) => index > 0 && line.trim().length > 0);
    expect(sentence).toBe(pkg.description);
  });

  it("has no leftover pulsar / atom-ide / unscoped-etch references in lib", () => {
    const libDir = path.join(root, "lib");
    for (const file of fs.readdirSync(libDir)) {
      if (!file.endsWith(".js")) continue;
      const src = fs.readFileSync(path.join(libDir, file), "utf8");
      expect(src.toLowerCase()).not.toContain("pulsar");
      expect(src).not.toContain("atom-ide");
      expect(src).not.toContain('require("etch")');
      expect(src).not.toContain("classnames");
    }
  });
});
