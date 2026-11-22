import React from "react";
import { useHostTheme } from "./theme";
import { studio } from "./studio";
import { WORKSPACE_NS, englishT, studioLocale, type WorkspaceTranslate } from "./workspace-i18n";

type StudioProps = {
  useTabInfo: () => { tab: { visible: boolean; navigation: { params?: { projectId?: string; page?: string } } } };
  sessionId?: string;
  t?: WorkspaceTranslate;
  activeLocale?: () => string;
};

// The host owns tab chrome, resizing, fullscreen, visibility and the composer.
export function StudioWorkspace({ useTabInfo, sessionId, t = englishT, activeLocale = () => "en" }: StudioProps): React.JSX.Element | null {
  const { tab } = useTabInfo();
  const theme = useHostTheme();
  const params = tab.navigation.params;
  const templates = params?.page === "templates" || (!params?.projectId && sessionId !== undefined && localStorage.getItem("omd-session-page:" + sessionId) === "templates");
  if (!tab.visible) return null;
  const language = "&locale=" + encodeURIComponent(studioLocale(activeLocale()));
  const url = templates ? studio + "/?embed=1&templates=1" + language
    : studio + "/?embed=1&hostChrome=1" + language + "#project/" + encodeURIComponent(params?.projectId || "project");
  return <section className="omd-studio-seat" data-motion-ui data-theme={theme}>
    <iframe title={templates ? t("iframe.templates") : t("iframe.studio")} src={url}
      onLoad={() => { if (templates) window.dispatchEvent(new Event("openmotion:library-ready")); }}
      allow="clipboard-write; fullscreen" />
  </section>;
}

export function registerEditingWorkspace(ctx: any): void {
  const activeLocale = () => ctx.locale?.getLocale().active ?? "en";
  ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab", key: "openmotion.studio", locale: WORKSPACE_NS,
    inject: (sessionId: string) => ({ sessionId, activeLocale }),
  }, StudioWorkspace));
}