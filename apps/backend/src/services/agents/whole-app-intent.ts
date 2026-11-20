
const WHOLE_APP_PATTERNS: RegExp[] = [
  /\b(build|create|make|develop|generate|ship|write|code)\b[^.?!]{0,40}\b(whole|entire|full|complete|complete)\b[^.?!]{0,30}\b(app|application|site|website|platform|product|system|mvp|saas|marketplace|game|thing)\b/i,
  /\b(build|create|make|develop|generate|ship|write|code)\b[^.?!]{0,40}\b(app|application|website|site|platform|product|system|mvp|saas|marketplace|game)\b[^.?!]{0,30}\bfrom scratch\b/i,
  /\b(build|create|make|develop)\b[^.?!]{0,20}\b(the whole thing|it all|everything)\b/i,
  /\b(build|create|develop|generate)\b (me |us )?(the |my |our )(app|application|website|platform|product|mvp|saas|marketplace|game)\b(\s+for\s+(me|us))?\s*([.?!]|$)/i,
  /\b(build|create|make|develop|generate)\b (me |us )?(a |an )(?:(?!(?:app|application|website|platform|product|mvp|saas|marketplace|game)\b)[\w-]+ ){0,6}(app|application|website|platform|product|mvp|saas|marketplace|game)\b(?!'s)/i,
];

export type AppBuildScope = "existing" | "whole_app" | "separate_app";

const SEPARATE_APP_PATTERNS = [
  /\b(build|create|make|develop|generate|ship|write|code)\b\s+(?:(?:me|us)\s+)?(?:(?:a|an|the|my|our)\s+)?(?:new\s+)?(?:standalone|separate|independent)\s+(?:[\w-]+\s+){0,4}(?:app|application|website|site|platform|product|system|mvp|saas|marketplace|game)\b/i,
  /\b(build|create|make|develop|generate|ship|write|code)\b[^.?!]{0,60}\b(?:app|application|website|site|platform|product|system|mvp|saas|marketplace|game)\b\s+(?:as\s+)?a\s+(?:separate|independent|standalone)\s+(?:app|application|product|project|game)\b/i,
  /\b(build|create|make|develop|generate|ship|write|code)\b[^.?!]{0,60}\b(?:app|application|website|site|platform|product|system|mvp|saas|marketplace|game)\b[, ]+separate\s+from\b/i,
];

const BUILD_OBJECT = /\b(?:build|create|make|develop|generate|ship|write|code)\b([^.?!]{0,80}?)\b(?:app|application|website|site|platform|product|system|mvp|saas|marketplace|game)\b(.*)/i;
const APP_REFERENCE_PREFIX = /\b(?:for|of|in|inside|within|into|on)\s+(?:(?:the|my|our|this|that|an?|existing|current)\s+(?:[\w-]+\s+){0,4})?$/i;
const COMPONENT_TAIL = /^(?:'s)?\s+(?:pages?|listings?|cards?|sections?|features?|buttons?|forms?|fields?|images?|descriptions?|categor(?:y|ies)|details?|lists?|tabs?|modals?|links?|titles?|names?|photos?|prices?|reviews?|screens?|views?|components?|filters?|banners?|logos?|icons?|menus?|tables?|entry|entries|variants?|tags?|headers?|footers?|settings?|levels?|controls?|scores?|widgets?|modes?)\b/i;
const EMBEDDED_TAIL = /^(?:\s+from scratch)?\s+(?:in|inside|within|into)\s+(?:(?:the|my|our|an?)\s+)?(?:(?:existing|current)\s+)?(?:app|application|website|site|game)\b/i;

const SPANISH_SEPARATE_APP = /\b(?:crea|crear|construye|construir|haz|hacer|desarrolla|desarrollar)\s+(?:un|una)\s+(?:(?:nuevo|nueva)\s+)?(?:app|aplicacion|sitio(?:\s+web)?|web|juego|plataforma|producto)\s+(?:(?:nuevo|nueva)\s+)?(?:separad[oa]|independiente)\b(.*)/i;
const SPANISH_EMBEDDED_TAIL = /^(?:\s+desde cero)?\s+(?:en|dentro de)\s+(?:(?:el|la|mi|nuestra|nuestro|una?)\s+)?(?:app|aplicacion|sitio|web|juego)\b/i;
const SPANISH_NEGATED_BUILD = /\b(?:no|nunca)\s+(?:quiero\s+)?(?:crea|crear|construye|construir|haz|hacer|desarrolla|desarrollar)\b/i;

export function appBuildScope(intent: string | null | undefined): AppBuildScope {
  if (!intent) return "existing";
  const clauses = intent.slice(0, 4000).split(/[.?!;\n]|\b(?:but|instead)\b/i);
  const negatedBuild = /\b(?:do not|don't|never|not to)\s+(?:build|create|make|develop|generate|ship|write|code)\b/i;
  let scope: AppBuildScope = "existing";
  for (const clause of clauses) {
    if (negatedBuild.test(clause)) continue;
    const spanishClause = clause.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const spanishSeparate = SPANISH_SEPARATE_APP.exec(spanishClause);
    if (spanishSeparate && !SPANISH_NEGATED_BUILD.test(spanishClause) && !SPANISH_EMBEDDED_TAIL.test(spanishSeparate[1])) {
      return "separate_app";
    }
    const object = BUILD_OBJECT.exec(clause);
    if (object && (APP_REFERENCE_PREFIX.test(object[1]) || COMPONENT_TAIL.test(object[2]) || EMBEDDED_TAIL.test(object[2]))) continue;
    if (!WHOLE_APP_PATTERNS.some((re) => re.test(clause))) continue;
    if (SEPARATE_APP_PATTERNS.some((re) => re.test(clause))) return "separate_app";
    scope = "whole_app";
  }
  return scope;
}

export function isWholeAppBuildIntent(intent: string | null | undefined): boolean {
  return appBuildScope(intent) !== "existing";
}
