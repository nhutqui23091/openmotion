// Workspace copy for the DSH dashboard, registered through the host locale
// service so the panel follows the DSH display language. English values are
// the historical panel copy; zh mirrors it. Keys are dotted and stable.
export const WORKSPACE_NS = "openmotionWorkspace";

export type WorkspaceTranslate = (key: string, params?: Record<string, string>) => string;

const en = {
  "page.workspace": "Workspace",
  "page.templates": "Templates",
  "page.brands": "Brand Kits",
  "page.assets": "Assets",
  "badge.local": "Local workspace",
  "action.agentChat": "Agent chat",
  "nav.aria": "OpenMotion workspace",
  "nav.overview": "Overview",
  "nav.studio": "Studio",
  "nav.templates": "Templates",
  "nav.brands": "Brand Kits",
  "nav.assets": "Assets",
  "link.standalone": "Open standalone ↗",
  "hero.kicker": "YOUR IDEAS. IN MOTION.",
  "hero.title": "What will you bring to life?",
  "hero.subtitle": "Start with an idea. Shape it with your agent. Make it yours in Studio.",
  "compose.label": "Describe your video",
  "compose.placeholder": "A launch video for your next big thing…",
  "compose.flow": "Idea → Agent → Editable video",
  "compose.submit": "Create with agent",
  "quick.launch": "Create a product launch",
  "quick.recreate": "Recreate a reference video",
  "quick.adapt": "Adapt a template",
  "projects.aria": "Projects",
  "projects.title": "Pick up where you left off",
  "projects.loading": "Loading projects…",
  "projects.failure": "Could not load projects",
  "common.loading": "Loading…",
  "common.refresh": "Refresh",
  "common.retry": "Retry",
  "project.artTop": "Make something",
  "project.artBottom": "move.",
  "project.meta": "Local project · Open in Studio",
  "project.new": "A fresh start",
  "project.newHint": "Bring an idea to your agent",
  "templates.aria": "Templates",
  "templates.title": "A little inspiration goes a long way",
  "templates.subtitle": "Motion references and editable templates, ready to explore.",
  "templates.refresh": "Refresh templates",
  "templates.explore": "Explore library",
  "templates.loading": "Loading templates…",
  "templates.failure": "Could not load templates",
  "template.editable": "Editable template",
  "template.reference": "Motion reference",
  "footer.workspace": "One workspace. Your agent and your Studio.",
  "footer.local": "Projects are stored locally",
  "guide.description": "Edit and preview your video project",
  "action.openProject": "Open current OpenMotion project",
  "iframe.templates": "OpenMotion Templates",
  "iframe.studio": "OpenMotion Studio",
  "prompt.default": "Help me create a short product video. Ask me about the product, audience and style first.",
  "prompt.newProject": "Help me plan a new video project.",
  "prompt.suffix": "OpenMotion project: {title} ({id}). Use OpenMotion tools to read the latest project before editing. Confirm the brief with me before creating a new project.",
};

const zh: Record<keyof typeof en, string> = {
  "page.workspace": "工作台",
  "page.templates": "模板库",
  "page.brands": "品牌套件",
  "page.assets": "素材库",
  "badge.local": "本地工作区",
  "action.agentChat": "Agent 对话",
  "nav.aria": "OpenMotion 工作台",
  "nav.overview": "概览",
  "nav.studio": "Studio",
  "nav.templates": "模板库",
  "nav.brands": "品牌套件",
  "nav.assets": "素材库",
  "link.standalone": "独立窗口打开 ↗",
  "hero.kicker": "你的创意，动起来",
  "hero.title": "你想让什么动起来？",
  "hero.subtitle": "从一个想法出发，与 Agent 一起打磨，在 Studio 里做成你的作品。",
  "compose.label": "描述你的视频",
  "compose.placeholder": "为你的下一个大作品做一支发布视频……",
  "compose.flow": "想法 → Agent → 可编辑视频",
  "compose.submit": "与 Agent 一起创作",
  "quick.launch": "做一支产品发布视频",
  "quick.recreate": "复刻一支参考视频",
  "quick.adapt": "改编一个模板",
  "projects.aria": "项目",
  "projects.title": "继续上次的创作",
  "projects.loading": "正在加载项目…",
  "projects.failure": "项目加载失败",
  "common.loading": "加载中…",
  "common.refresh": "刷新",
  "common.retry": "重试",
  "project.artTop": "让创意",
  "project.artBottom": "动起来。",
  "project.meta": "本地项目 · 在 Studio 中打开",
  "project.new": "全新开始",
  "project.newHint": "把想法交给 Agent",
  "templates.aria": "模板",
  "templates.title": "一点灵感，大有不同",
  "templates.subtitle": "动效参考与可编辑模板，随时探索。",
  "templates.refresh": "刷新模板",
  "templates.explore": "浏览模板库",
  "templates.loading": "正在加载模板…",
  "templates.failure": "模板加载失败",
  "template.editable": "可编辑模板",
  "template.reference": "动效参考",
  "footer.workspace": "一个工作台，你的 Agent 与 Studio。",
  "footer.local": "项目保存在本地",
  "guide.description": "编辑并预览你的视频项目",
  "action.openProject": "打开当前 OpenMotion 项目",
  "iframe.templates": "OpenMotion 模板库",
  "iframe.studio": "OpenMotion Studio",
  "prompt.default": "帮我做一支简短的产品视频。请先问我产品、受众和风格。",
  "prompt.newProject": "帮我规划一个新的视频项目。",
  "prompt.suffix": "OpenMotion 项目：{title}（{id}）。编辑前先用 OpenMotion 工具读取最新项目；创建新项目前先与我确认简报。",
};

export const workspaceMessages = { en, zh };

function interpolate(template: string, params?: Record<string, string>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match);
}

/** Standalone fallback (tests, or a host without the locale service): English copy. */
export const englishT: WorkspaceTranslate = (key, params) =>
  interpolate((en as Record<string, string>)[key] ?? key, params);

/** Register the workspace dictionaries with the host locale service when present. */
export function registerWorkspaceLocale(ctx: { effect: (fn: () => (() => void) | void, label?: string) => unknown; locale?: { register: (ns: string, dicts: typeof workspaceMessages) => () => void } }): void {
  ctx.effect(() => ctx.locale?.register(WORKSPACE_NS, workspaceMessages), "openmotion-dsh: workspace locale");
}

/** Map a DSH display-language id to a Studio locale for embedded iframe URLs. */
export function studioLocale(active: string): string {
  const id = active.toLowerCase();
  if (id === "zh" || id.startsWith("zh-")) return "zh-CN";
  if (id === "pt" || id.startsWith("pt-")) return "pt-BR";
  const supported = ["en", "ja", "ko", "de", "fr", "ru", "es", "it", "tr"];
  const primary = id.split("-")[0];
  return supported.includes(primary) ? primary : "en";
}