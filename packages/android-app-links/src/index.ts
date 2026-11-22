// Android App Links for a web product: Digital Asset Links and the sign-in return page.
//
// Each product passes its own package names, certificate fingerprints and brand. It serves:
//   GET /.well-known/assetlinks.json  Digital Asset Links naming the product's Android apps
//   GET /android/callback             the sign-in return path the app intercepts as a verified App
//                                     Link; in a browser (app not installed) a branded page saying to
//                                     open the app, which never reflects the code or state it was sent.

import { createHash } from "node:crypto";

export const ASSET_LINKS_PATH = "/.well-known/assetlinks.json";
export const ANDROID_CALLBACK_PATH = "/android/callback";

export interface AndroidAppSettings {
  /** Debug build application id, for example com.example.app.debug. */
  debugPackage?: string;
  /** Comma-separated SHA-256 signing-certificate fingerprints for the debug build. */
  debugCertSha256?: string;
  /** Release build application id, for example com.example.app. */
  releasePackage?: string;
  /** Comma-separated SHA-256 signing-certificate fingerprints for the release build. */
  releaseCertSha256?: string;
}

export interface AndroidAppTarget {
  packageName: string;
  fingerprints: string[];
}

export interface CallbackBrand {
  /** Product name, for example Notes. */
  name: string;
  /** Same-origin logo path, shown at its own proportions. */
  logo: string;
  /** Where the page's link goes, normally "/". */
  homeHref: string;
  /** Colours of the product theme: page background, glow, button and focus ring. */
  colors: { base: string; glow: string; button: string; buttonBorder: string; buttonText: string; focus: string };
}

const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export class AndroidLinksConfigError extends Error {}

/** Splits and normalises a comma-separated fingerprint list; throws on any malformed entry. */
export function parseFingerprints(value: string | undefined): string[] {
  const list = (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
  for (const entry of list)
    if (!FINGERPRINT.test(entry)) throw new AndroidLinksConfigError("A signing-certificate fingerprint is malformed");
  return [...new Set(list)];
}

/**
 * The apps to declare: one statement per build whose package and fingerprints are both configured.
 * A build with a package but no fingerprints yet (the release key before it exists) is left out.
 */
export function androidTargets(settings: AndroidAppSettings): AndroidAppTarget[] {
  const targets: AndroidAppTarget[] = [];
  for (const [rawPackage, rawPrints] of [
    [settings.debugPackage, settings.debugCertSha256],
    [settings.releasePackage, settings.releaseCertSha256],
  ]) {
    const packageName = rawPackage?.trim();
    const fingerprints = parseFingerprints(rawPrints);
    if (!packageName || !fingerprints.length) continue;
    if (!PACKAGE.test(packageName)) throw new AndroidLinksConfigError("An Android package name is malformed");
    targets.push({ packageName, fingerprints });
  }
  return targets;
}

/** The Digital Asset Links statement list for the given apps. */
export function assetLinks(targets: AndroidAppTarget[]) {
  return targets.map((target) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: target.packageName,
      sha256_cert_fingerprints: target.fingerprints,
    },
  }));
}

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page a browser shows at /android/callback. Built only from the brand, never from the URL. */
export function callbackPage(brand: CallbackBrand): { html: string; styleHash: string } {
  const c = brand.colors;
  const style = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0}
.page{min-height:100vh;min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:max(40px,env(safe-area-inset-top)) 24px max(24px,env(safe-area-inset-bottom));background:radial-gradient(ellipse at 55% 30%,${c.glow} 0,transparent 57%),${c.base};color:#eef3f9;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}
.card{width:100%;max-width:420px;display:flex;flex-direction:column;align-items:center;padding:32px 0 40px}
.logo{display:block;width:104px;height:104px;object-fit:contain;border-radius:0;clip-path:none;mask:none}
h1{margin:22px 0 0;font-size:54px;line-height:1.05;letter-spacing:-2px;font-weight:700;color:#f4f7fb}
.lead{margin:14px 0 0;font-size:19px;line-height:1.45;font-weight:500;color:#c3d1e3;text-wrap:balance}
.note{margin:16px 0 0;font-size:15px;line-height:1.5;color:#aab6c6}
.home{align-self:stretch;display:flex;align-items:center;justify-content:center;min-height:54px;margin-top:32px;padding:10px 16px;border:1px solid ${c.buttonBorder};border-radius:10px;background:${c.button};color:${c.buttonText};font-size:15px;font-weight:650;text-decoration:none}
.home:focus-visible{outline:3px solid ${c.focus};outline-offset:3px}
@media (max-width:380px){h1{font-size:44px}}
`.trim();
  const name = escape(brand.name);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Open the ${name} app</title>
<style>${style}</style>
</head>
<body>
<main class="page">
<div class="card">
<img class="logo" src="${escape(brand.logo)}" alt="" width="104" height="104">
<h1>${name}</h1>
<p class="lead">Open the ${name} app on this phone to finish signing in.</p>
<p class="note">This link is for the ${name} Android app. If the app isn't on this phone, you can keep using ${name} in your browser.</p>
<a class="home" href="${escape(brand.homeHref)}">Go to ${name}</a>
</div>
</main>
</body>
</html>
`;
  return { html, styleHash: createHash("sha256").update(style).digest("base64") };
}

/**
 * Answers the two App Link paths, or returns null for any other path. Responses carry their own
 * content type, caching and (for the page) content security policy; callers may add their usual
 * security headers but should keep this CSP, which allows only the page's own hashed style.
 */
export function handleAndroidLinks(
  request: Request,
  settings: AndroidAppSettings,
  brand: CallbackBrand,
): Response | null {
  const path = new URL(request.url).pathname;
  if (path !== ASSET_LINKS_PATH && path !== ANDROID_CALLBACK_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const head = request.method === "HEAD";
  if (path === ASSET_LINKS_PATH) {
    let targets: AndroidAppTarget[];
    try {
      targets = androidTargets(settings);
    } catch {
      return Response.json({ error: "App links are misconfigured" }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    if (!targets.length)
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(head ? null : JSON.stringify(assetLinks(targets)), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    });
  }
  const page = callbackPage(brand);
  return new Response(head ? null : page.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "content-security-policy": `default-src 'none'; img-src 'self'; style-src 'sha256-${page.styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}
