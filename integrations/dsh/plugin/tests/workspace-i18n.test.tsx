import { expect, it } from "vitest";
import { englishT, studioLocale, workspaceMessages } from "../src/workspace-i18n";

it("maps DSH display languages to Studio locales", () => {
  expect(studioLocale("zh")).toBe("zh-CN");
  expect(studioLocale("zh-CN")).toBe("zh-CN");
  expect(studioLocale("pt")).toBe("pt-BR");
  expect(studioLocale("pt-PT")).toBe("pt-BR");
  expect(studioLocale("en")).toBe("en");
  expect(studioLocale("en-US")).toBe("en");
  expect(studioLocale("ja")).toBe("ja");
  expect(studioLocale("xx")).toBe("en");
});

it("keeps the zh dictionary complete against the en key set", () => {
  expect(Object.keys(workspaceMessages.zh).sort()).toEqual(Object.keys(workspaceMessages.en).sort());
});

it("interpolates params and falls back to the key for unknown copy", () => {
  expect(englishT("prompt.suffix", { title: "Launch", id: "p1" })).toContain("OpenMotion project: Launch (p1)");
  expect(englishT("missing.key")).toBe("missing.key");
});