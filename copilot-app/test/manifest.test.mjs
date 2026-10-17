// Validates the plugin packaging: plugin.json, the marketplace entry that points at it, and that no
// personal canvas data (snapshots, locks) ever lands in the plugin folder.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CANVAS_ID } from "../com.github.copilot/extensions/ai-fluency/canvas.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pluginRoot, "..");
const extensionDir = join(pluginRoot, "com.github.copilot", "extensions", "ai-fluency");

const AGENT_PLUGINS_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const ALLOWED_KEYS = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
const NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const plugin = readJson(join(pluginRoot, "plugin.json"));
const marketplace = readJson(join(repoRoot, ".github", "plugin", "marketplace.json"));
const entry = marketplace.plugins?.find((p) => p.name === plugin.name);

function walk(dir, found = []) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        found.push(path);
        if (statSync(path).isDirectory()) walk(path, found);
    }
    return found;
}

test("plugin.json is a valid Agent Plugins 1.0 manifest", () => {
    assert.equal(plugin.$schema, AGENT_PLUGINS_SCHEMA);
    assert.equal(plugin.name, "ai-fluency-canvas");
    assert.match(plugin.name, NAME);
    assert.match(plugin.version, SEMVER);
    assert.deepEqual(Object.keys(plugin).filter((key) => !ALLOWED_KEYS.has(key)), [], "Agent Plugins 1.0 has a closed schema");
    assert.equal(typeof plugin.description, "string");
    assert.equal(typeof plugin.author?.name, "string");
    assert.ok(Array.isArray(plugin.keywords) && plugin.keywords.every((k) => typeof k === "string"));
});

test("marketplace.json lists the plugin with a matching source and version", () => {
    assert.match(marketplace.name, NAME);
    assert.equal(typeof marketplace.owner?.name, "string");
    assert.ok(entry, `marketplace.json has no entry named ${plugin.name}`);
    assert.equal(typeof entry.source, "string");
    assert.equal(resolve(repoRoot, entry.source), pluginRoot, "source must resolve to copilot-app/");
    assert.equal(entry.version, plugin.version, "bump the version in plugin.json and marketplace.json together");
    for (const key of ["description", "homepage", "repository", "license"]) {
        assert.equal(entry[key], plugin[key], `marketplace ${key} drifted from plugin.json`);
    }
    assert.deepEqual(entry.author, plugin.author);
    assert.deepEqual(entry.keywords, plugin.keywords);
});

test("the canvas extension and its manual-install manifest are present", () => {
    assert.ok(existsSync(join(extensionDir, "extension.mjs")), "com.github.copilot/extensions/ai-fluency/extension.mjs is missing");
    for (const asset of ["index.html", "app.js", "style.css"]) {
        assert.ok(existsSync(join(extensionDir, "assets", asset)), `assets/${asset} is missing`);
    }
    assert.deepEqual(readJson(join(extensionDir, "copilot-extension.json")), { name: "ai-fluency", version: 1 });
    assert.equal(CANVAS_ID, "ai-fluency", "canvasId must stay ai-fluency");
    const entry = readFileSync(join(extensionDir, "extension.mjs"), "utf8");
    assert.match(entry, /from "@github\/copilot-sdk\/extension"/, "extension.mjs must load the Copilot SDK");
    assert.match(entry, /await startExtension\(\{ createCanvas, CanvasError, joinSession \}\)/, "extension.mjs must register the canvas");
});

test("skills follow the Agent Plugins layout", () => {
    const skillsDir = join(pluginRoot, "skills");
    if (!existsSync(skillsDir)) return;
    for (const name of readdirSync(skillsDir)) {
        const skill = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
        assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\ndescription: .+\\r?\\n---`), `skills/${name}/SKILL.md needs name/description frontmatter`);
    }
});

test("no personal canvas data is shipped in the plugin", () => {
    const leaked = walk(pluginRoot)
        .map((path) => path.slice(pluginRoot.length + 1).replace(/\\/g, "/"))
        .filter((path) => /(^|\/)artifacts(\/|$)/.test(path) || /(^|\/)(snapshot\.json|refresh\.lock(\.[^/]*)?)$/.test(path) || /\.tmp$/.test(path));
    assert.deepEqual(leaked, []);
});
