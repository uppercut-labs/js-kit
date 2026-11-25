/** Markdown copy of an HTML route: `/a/b/` is `/a/b/index.md`, `/a/b` is `/a/b.md`, `/` is `/index.md`. */
export function mirrorRoute(route: string): string {
  return route.endsWith('/') ? `${route}index.md` : `${route}.md`;
}

/** The route a built HTML file is served at: `index.html` is `/`, `a/index.html` is `/a/`, `a/b.html` is `/a/b`. */
export function routeOfFile(file: string): string {
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  return `/${file.slice(0, -'.html'.length)}`;
}

/** A page title without the site name suffix (` · Name` or ` | Name`). */
export function shortTitle(title: string, name: string): string {
  for (const suffix of [` · ${name}`, ` | ${name}`]) if (title.endsWith(suffix)) return title.slice(0, -suffix.length);
  return title;
}
