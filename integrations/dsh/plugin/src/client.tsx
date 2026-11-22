import { IconGlyph } from "../../../../packages/design-system/react/IconGlyph";
import { useHostTheme } from "./theme";
import React, { useEffect, useState } from "react";
import { registerEditingWorkspace } from "./editing";
import { studio, configureStudio, studioAssetUrl } from "./studio";
import { useDashboardList } from "./useDashboardList";
import { OPENMOTION_TEMPLATE_ACTION } from "./templateRecommendationAction";
import { TemplateRecommendationCard } from "./TemplateRecommendationCard";
import { WORKSPACE_NS, englishT, registerWorkspaceLocale, studioLocale, type WorkspaceTranslate } from "./workspace-i18n";
const selectedKey = "openmotion-dsh-project";
type Page = "home" | "templates" | "brands" | "assets";
function pageName(t: WorkspaceTranslate, page: Page): string {
  return t(page === "home" ? "page.workspace" : page === "templates" ? "page.templates" : page === "brands" ? "page.brands" : "page.assets");
}
function libraryUrl(page: Page, templateId: string | null, locale: string): string {
  const language = "&locale=" + encodeURIComponent(studioLocale(locale));
  if (page === "templates")
    return (
      studio +
      "/?hostChrome=1&templates=1" + language +
      (templateId ? "&template=" + encodeURIComponent(templateId) : "")
    );
  return (
    studio +
    "/?hostChrome=1" + language + "&page=" +
    (page === "brands" ? "brand-kit" : "assets")
  );
}
type Project = { id: string; title: string; trashedAt?: number };
type Template = {
  id: string;
  title: string;
  description?: string;
  posterUrl?: string;
  previewUrl?: string;
  duration?: number;
  brand?: string;
  hasHtmlProject?: boolean;
  editable?: boolean;
};
function Icon({ name = "play", size = 18 }: { name?: string; size?: number }) {
  const ids: Record<string, string> = {
    play: "ri-play-fill",
    arrow: "ri-arrow-right-line",
    grid: "ri-layout-grid-line",
    plus: "ri-add-line",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <IconGlyph id={ids[name] || ids.play} />
    </svg>
  );
}
const Mark = () => (
  <img
    alt=""
    src={studio + "/design-system/brand/favicon.svg"}
    width="24"
    height="24"
  />
);

export function registerTemplateRecommendationBody(ctx: any): void {
  if (!ctx.actionCards?.register) return;
  ctx.effect(() => ctx.locale?.register("openmotionTemplateRecommendations", {
    en: {},
    zh: {},
    ja: {},
    ko: {},
    fr: {},
    es: {},
    de: {},
    ru: {},
    pt: {},
  }));
  ctx.effect(() => ctx.actionCards.register({
    action: OPENMOTION_TEMPLATE_ACTION,
    locale: "openmotionTemplateRecommendations",
    Body: function RecommendationBody(props: React.ComponentProps<typeof TemplateRecommendationCard>) {
      const [libraryOpened, setLibraryOpened] = useState(false);
      useEffect(() => {
        if (!props.proposal.details.onboarding) return;
        const ready = () => setLibraryOpened(true);
        window.addEventListener("openmotion:library-ready", ready);
        // Open the library in the current conversation's native right-hand pane.
        // This is browsing, so do not select or create a project.
        const callId = props.proposal.callId;
        const key = callId ? "omd-onboarding:" + callId : undefined;
        if (!key || localStorage.getItem(key) !== "requested") {
          ctx.sidebarRight.openTab("openmotion-studio", { params: { page: "templates" } });
          const sessionId = ctx.sidebarRight.mounted?.getSnapshot();
          if (sessionId) localStorage.setItem("omd-session-page:" + sessionId, "templates");
          if (key) localStorage.setItem(key, "requested");
        }
        return () => window.removeEventListener("openmotion:library-ready", ready);
      }, [props.proposal.callId, props.proposal.details.onboarding]);
      return <TemplateRecommendationCard {...props} proposal={{ ...props.proposal,
        details: { ...props.proposal.details, libraryOpened } }} />;
    },
  }), "openmotion-dsh: template recommendation body");
}
export function Dashboard({
  begin,
  openConversation,
  openProject,
  t = englishT,
  activeLocale = () => "en",
}: {
  begin: (prompt: string) => void;
  openConversation: () => void;
  openProject: (id: string) => void;
  t?: WorkspaceTranslate;
  activeLocale?: () => string;
}) {
  const theme = useHostTheme();
  const [page, setPage] = useState<Page>("home"),
    [templateId, setTemplateId] = useState<string | null>(null),
    [project, setProject] = useState(
      localStorage.getItem(selectedKey) || "project",
    );
  const [prompt, setPrompt] = useState("");
  const locale = activeLocale();
  const { items: projects, loading: projectsLoading, error: projectsError, reload: loadProjects } = useDashboardList<Project>(
    "/openmotion-dsh/data/motion-api/projects", "projects", t("projects.failure"),
  );
  const { items: templates, loading: templatesLoading, error: templatesError, reload: loadTemplates } = useDashboardList<Template>(
    "/openmotion-dsh/data/api/template-catalog?limit=6&locale=" + encodeURIComponent(locale) + "&covered=true", "items", t("templates.failure"),
  );
  const choose = (id: string) => {
    localStorage.setItem(selectedKey, id);
    setProject(id);
    openProject(id);
  };
  const current = projects.find((p) => p.id === project);
  const start = (text = prompt) =>
    begin(
      `${text || t("prompt.default")}\n\n` +
      t("prompt.suffix", { title: current?.title || project, id: project }),
    );
  return (
    <section className="omd" data-motion-ui data-theme={theme}>
      <header className="omd-top">
        <div className="omd-breadcrumb">
          <Mark />
          <strong>OpenMotion</strong>
          <span>/</span>
          <span>{pageName(t, page)}</span>
        </div>
        <div className="omd-top-right">
          <span className="ui-badge ui-badge--accent">
            <i className="omd-dot" /> {t("badge.local")}
          </span>
          <button
            className="ui-button ui-button--ghost ui-button--sm"
            onClick={openConversation}
          >
            {t("action.agentChat")} <Icon name="arrow" size={14} />
          </button>
        </div>
      </header>
      <nav className="omd-nav" aria-label={t("nav.aria")}>
        {[
          ["home", t("nav.overview")],
          ["studio", t("nav.studio")],
          ["templates", t("nav.templates")],
          ["brands", t("nav.brands")],
          ["assets", t("nav.assets")],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-current={page === id ? "page" : undefined}
            className={
              "ui-button ui-button--ghost " +
              (page === id ? "omd-nav-active" : "")
            }
            onClick={() => {
              if (id === "studio") {
                openProject(project);
                return;
              }
              setTemplateId(null);
              setPage(id as Page);
            }}
          >
            {label}
          </button>
        ))}
        <a
          className="omd-external"
          href={studio + "/?locale=" + encodeURIComponent(studioLocale(locale))}
          target="_blank"
          rel="noreferrer"
        >
          {t("link.standalone")}
        </a>
      </nav>
      {page !== "home" ? (
        <div className="omd-embedded">
          <iframe
            title={"OpenMotion " + pageName(t, page)}
            key={page}
            src={libraryUrl(page, templateId, locale)}
            allow="clipboard-write; fullscreen"
          />
        </div>
      ) : (
        <main className="omd-main">
          <div className="omd-kicker">{t("hero.kicker")}</div>
          <div className="omd-heading">
            <div>
              <h1>{t("hero.title")}</h1>
              <p>{t("hero.subtitle")}</p>
            </div>
            <span className="omd-version">OPENMOTION / DSH</span>
          </div>
          <form
            className="omd-compose"
            onSubmit={(e) => {
              e.preventDefault();
              start();
            }}
          >
            <label className="omd-sr" htmlFor="omd-prompt">
              {t("compose.label")}
            </label>
            <textarea
              id="omd-prompt"
              placeholder={t("compose.placeholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="omd-compose-bottom">
              <span>{t("compose.flow")}</span>
              <button className="ui-button ui-button--primary" type="submit">
                {t("compose.submit")} <Icon name="arrow" size={16} />
              </button>
            </div>
          </form>
          <div className="omd-quick">
            {[
              t("quick.launch"),
              t("quick.recreate"),
              t("quick.adapt"),
            ].map((s) => (
              <button
                className="ui-button ui-button--ghost ui-button--sm"
                key={s}
                onClick={() => setPrompt(s)}
              >
                {s} <span>↗</span>
              </button>
            ))}
          </div>
          <section className="omd-section" aria-label={t("projects.aria")} aria-busy={projectsLoading}>
            <div className="omd-section-head">
              <h2>{t("projects.title")}</h2>
              <button
                className="ui-button ui-button--ghost ui-button--sm"
                onClick={loadProjects}
                disabled={projectsLoading}
              >
                {projectsLoading ? t("common.loading") : t("common.refresh")}
              </button>
            </div>
            {projectsError && (
              <div className="omd-error" role="alert">
                {projectsError}{" "}
                <button className="ui-button ui-button--sm" onClick={loadProjects}>
                  {t("common.retry")}
                </button>
              </div>
            )}
            <div className="omd-project-grid">
              {projectsLoading && projects.length === 0 && <>
                <span className="omd-sr" role="status">{t("projects.loading")}</span>
                {Array.from({ length: 2 }, (_, index) => <div className="omd-project" aria-hidden="true" key={index}>
                  <div className="omd-project-art ui-skeleton" />
                  <div className="omd-project-meta"><span className="ui-skeleton omd-placeholder-line" /></div>
                </div>)}
              </>}
              {projects
                .filter((p) => !p.trashedAt)
                .map((p) => (
                  <button
                    className="omd-project"
                    key={p.id}
                    onClick={() => choose(p.id)}
                  >
                    <div className="omd-project-art">
                      <Mark />
                      <span>
                        {t("project.artTop")}
                        <br />
                        <em>{t("project.artBottom")}</em>
                      </span>
                      <span className="omd-project-play">
                        <Icon />
                      </span>
                    </div>
                    <div className="omd-project-meta">
                      <div>
                        <strong>{p.title}</strong>
                        <small>{t("project.meta")}</small>
                      </div>
                      <Icon name="arrow" size={16} />
                    </div>
                  </button>
                ))}
              <button
                className="omd-new"
                onClick={() => start(t("prompt.newProject"))}
              >
                <Icon name="plus" size={24} />
                <strong>{t("project.new")}</strong>
                <small>{t("project.newHint")}</small>
              </button>
            </div>
          </section>
          <section className="omd-section" aria-label={t("templates.aria")} aria-busy={templatesLoading}>
            <div className="omd-section-head">
              <div>
                <h2>{t("templates.title")}</h2>
                <p>{t("templates.subtitle")}</p>
              </div>
              <div className="omd-list-actions">
                <button className="ui-button ui-button--ghost ui-button--sm" onClick={loadTemplates} disabled={templatesLoading}>
                  {templatesLoading ? t("common.loading") : t("templates.refresh")}
                </button>
                <button className="ui-button ui-button--ghost ui-button--sm" onClick={() => setPage("templates")}>
                  {t("templates.explore")} <Icon name="arrow" size={14} />
                </button>
              </div>
            </div>
            {templatesError && <div className="omd-error" role="alert">
              {templatesError}{" "}
              <button className="ui-button ui-button--sm" onClick={loadTemplates}>{t("common.retry")}</button>
            </div>}
            <div className="omd-template-grid">
              {templatesLoading && templates.length === 0 && <>
                <span className="omd-sr" role="status">{t("templates.loading")}</span>
                {Array.from({ length: 6 }, (_, index) => <div className="omd-template" aria-hidden="true" key={index}>
                  <div className="omd-template-art ui-skeleton" />
                  <div className="omd-template-meta"><span className="ui-skeleton omd-placeholder-line" /></div>
                </div>)}
              </>}
              {templates.map((template) => (
                <button
                  className="omd-template"
                  key={template.id}
                  onClick={() => {
                    setTemplateId(template.id);
                    setPage("templates");
                  }}
                >
                  <div className="omd-template-art">
                    <img src={studioAssetUrl(template.posterUrl)} alt="" loading="eager" />
                    {template.duration != null && Number.isFinite(template.duration) && <span className="omd-duration">
                      {Math.round(template.duration)}s
                    </span>}
                    <span className="omd-template-play">
                      <Icon size={22} />
                    </span>
                  </div>
                  <div className="omd-template-meta">
                    <strong>{template.title}</strong>
                    <span>
                      {template.hasHtmlProject
                        ? t("template.editable")
                        : t("template.reference")}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>
          <footer className="omd-foot">
            <span>{t("footer.workspace")}</span>
            <span>{t("footer.local")}</span>
          </footer>
        </main>
      )}
    </section>
  );
}
export const inject = [
  "slots",
  "layout",
  "uiWorkspace",
  "sidebarRight",
  "sidebarRightTabs",
  "actionCards",
  "locale",
];
export async function apply(ctx: any) {
  const response = await fetch("/openmotion-dsh/status");
  if (!response.ok)
    throw new Error(
      "OpenMotion host connection is unavailable. Restart DSH and inspect its log.",
    );
  configureStudio((await response.json()).studioUrl);
  registerWorkspaceLocale(ctx);
  registerTemplateRecommendationBody(ctx);
  const links = [
    "/openmotion-dsh/design-system/ui.css",
    "/openmotion-dsh/design-system/studio/feedback.css",
    "/openmotion-dsh/style.css",
  ].map((href) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
    return link;
  });
  ctx.effect(() => () => links.forEach((l) => l.remove()));
  const activeLocale = () => ctx.locale?.getLocale().active ?? "en";
  const begin = (prompt: string) =>
    ctx.uiWorkspace.startSession(undefined, {
      prompt,
      whenDraftExists: "keep",
    });
  const openConversation = () => ctx.layout.selectPanel(null);
  let cancelPendingOpen: (() => void) | undefined;
  ctx.effect(() => () => cancelPendingOpen?.());
  function openProject(projectId: string): void {
    cancelPendingOpen?.();
    openConversation();
    const mounted = ctx.sidebarRight.mounted;
    function openWhenMounted(): boolean {
      const sessionId = mounted.getSnapshot();
      if (!sessionId) return false;
      cancelPendingOpen?.();
      cancelPendingOpen = undefined;
      // The selection is published before React adopts the session's tab store.
      requestAnimationFrame(() => {
        if (mounted.getSnapshot() !== sessionId) return;
        localStorage.setItem("omd-session:" + sessionId, projectId);
        localStorage.removeItem("omd-session-page:" + sessionId);
        ctx.sidebarRight.openTab("openmotion-studio", { params: { projectId } });
      });
      return true;
    }
    // A fresh DSH profile has no session seat yet. Wait for its native blank
    // session instead of losing the tab-open request before that seat mounts.
    requestAnimationFrame(() => {
      if (openWhenMounted()) return;
      cancelPendingOpen = mounted.subscribe(openWhenMounted);
      ctx.uiWorkspace.startSession();
    });
  }
  ctx.slots.inject("main", () =>
    ctx.slots.register(
      {
        name: "main",
        key: "openmotion",
        locale: WORKSPACE_NS,
        inject: () => ({ begin, openConversation, openProject, activeLocale }),
      },
      Dashboard,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: "openmotion",
        order: -100,
        label: "OpenMotion",
      },
      () => <Mark />,
    ),
  );
  ctx.effect(() =>
    ctx.sidebarRightTabs.register({
      id: "openmotion.studio",
      kind: "openmotion-studio",
      title: () => "OpenMotion",
      guide: [
        {
          id: "studio",
          order: -20,
          title: () => "OpenMotion",
          description: () => ctx.locale?.translate(WORKSPACE_NS, "guide.description") ?? englishT("guide.description"),
        },
      ],
    }),
  );
  registerEditingWorkspace(ctx);
  const studioActions = (sessionId: string) => ({
    openStudio: () => {
      const key = "omd-session:" + sessionId;
      const project =
        localStorage.getItem(key) ||
        localStorage.getItem(selectedKey) ||
        "project";
      localStorage.setItem(key, project);
      ctx.sidebarRight.openTab("openmotion-studio", {
        params: localStorage.getItem("omd-session-page:" + sessionId) === "templates" ? { page: "templates" } : { projectId: project },
      });
    },
  });
  const StudioAction = ({ openStudio, t = englishT }: { openStudio: () => void; t?: WorkspaceTranslate }) => (
    <span data-motion-ui data-theme={useHostTheme()}>
      <button
        className="ui-button ui-button--ghost ui-button--sm"
        onClick={openStudio}
        title={t("action.openProject")}
      >
        <Icon size={15} /> OpenMotion
      </button>
    </span>
  );
  for (const slot of ["conversation.session.header.actions"])
    ctx.slots.inject(slot, () =>
      ctx.slots.register(
        { name: slot, id: "openmotion-studio", locale: WORKSPACE_NS, inject: studioActions },
        StudioAction,
      ),
    );
}