import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ANDROID_CALLBACK_PATH,
  ASSET_LINKS_PATH,
  AndroidLinksConfigError,
  androidTargets,
  assetLinks,
  callbackPage,
  handleAndroidLinks,
  parseFingerprints,
  type AndroidAppSettings,
  type CallbackBrand,
} from "../src/index.js";

// The cases are the union of what four products check through their HTTP handlers: settings from
// ANDROID_* variables, each product's own brand, and the two paths served.
const ORIGIN = "https://product.example.test";
const DEBUG = "DC:94:A5:23:0F:8B:2C:0A:82:29:DB:C1:96:87:34:94:AC:85:96:79:0E:35:DF:CD:A2:75:B5:A0:79:AB:1A:FB";
const RELEASE = "0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9";
const settings = (extra: AndroidAppSettings = {}): AndroidAppSettings => ({
  debugPackage: "com.example.product.debug",
  debugCertSha256: DEBUG,
  releasePackage: "com.example.product",
  releaseCertSha256: "",
  ...extra,
});
const brand: CallbackBrand = {
  name: "Product",
  logo: "/icon.svg",
  homeHref: "/",
  colors: { base: "#0c1016", glow: "#1b2b43", button: "#dceafd", buttonBorder: "#cadcf5", buttonText: "#0c203c", focus: "#8db8f2" },
};
const get = (path: string, s = settings(), init?: RequestInit) => handleAndroidLinks(new Request(ORIGIN + path, init), s, brand);

describe("fingerprints and targets", () => {
  it("normalises, de-duplicates and validates fingerprint lists", () => {
    expect(parseFingerprints(` ${RELEASE.toLowerCase()} , ${RELEASE}`)).toEqual([RELEASE]);
    expect(parseFingerprints(undefined)).toEqual([]);
    expect(parseFingerprints(" , ")).toEqual([]);
    expect(() => parseFingerprints("zz")).toThrow(AndroidLinksConfigError);
    expect(() => parseFingerprints("DC:94")).toThrow(AndroidLinksConfigError);
  });

  it("declares a build only once both its package and fingerprints exist, and rejects bad package names", () => {
    expect(androidTargets(settings())).toEqual([{ packageName: "com.example.product.debug", fingerprints: [DEBUG] }]);
    expect(androidTargets({ debugPackage: "com.example.app", debugCertSha256: "" })).toEqual([]);
    expect(androidTargets(settings({ releaseCertSha256: RELEASE }))).toHaveLength(2);
    expect(() => androidTargets(settings({ debugPackage: "not a package" }))).toThrow(AndroidLinksConfigError);
    expect(() => androidTargets(settings({ debugPackage: "single" }))).toThrow(AndroidLinksConfigError);
  });

  it("builds Digital Asset Links statements", () => {
    expect(assetLinks([{ packageName: "com.example.app", fingerprints: [DEBUG] }])).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "com.example.app", sha256_cert_fingerprints: [DEBUG] },
      },
    ]);
  });
});

describe(`GET ${ASSET_LINKS_PATH}`, () => {
  it("serves the configured apps as cacheable JSON", async () => {
    const response = get(ASSET_LINKS_PATH, settings({ releaseCertSha256: RELEASE }))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = await response.json();
    expect(body).toHaveLength(2);
    expect(body[1].target).toEqual({ namespace: "android_app", package_name: "com.example.product", sha256_cert_fingerprints: [RELEASE] });
  });

  it("is absent when nothing is configured and fails closed on malformed configuration", () => {
    expect(get(ASSET_LINKS_PATH, {})!.status).toBe(404);
    expect(get(ASSET_LINKS_PATH, settings({ debugCertSha256: "DC:94" }))!.status).toBe(503);
    expect(get(ASSET_LINKS_PATH, settings({ debugPackage: "not a package" }))!.status).toBe(503);
    expect(get(ASSET_LINKS_PATH, settings({ debugPackage: "not a package" }))!.headers.get("cache-control")).toBe("no-store");
  });
});

describe(`GET ${ANDROID_CALLBACK_PATH} in a browser`, () => {
  const code = "AUTHCODE-should-never-appear";
  const state = "STATE-should-never-appear";

  it("serves the branded open-the-app page without echoing the code or state", async () => {
    const response = get(`${ANDROID_CALLBACK_PATH}?code=${code}&state=${state}&iss=https%3A%2F%2Faccount.example`)!;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const html = await response.text();
    expect(html).toContain("<h1>Product</h1>");
    expect(html).toContain("Open the Product app on this phone to finish signing in.");
    expect(html).toContain('<a class="home" href="/">Go to Product</a>');
    expect(html).toContain('src="/icon.svg"');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    for (const secret of [code, state, "account.example", "AUTHCODE", "STATE-"]) expect(html).not.toContain(secret);
    expect(html).not.toMatch(/<script/i);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain(`style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("keeps the logo at its own proportions, unclipped", () => {
    const { html } = callbackPage(brand);
    expect(html).toContain(".logo{display:block;width:104px;height:104px;object-fit:contain;border-radius:0;clip-path:none;mask:none}");
  });

  it("escapes the brand it is given", () => {
    const { html } = callbackPage({ ...brand, name: `<b>"x"&'y'</b>`, logo: `/a"b.svg`, homeHref: `/?q=<x>` });
    expect(html).toContain("&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;");
    expect(html).toContain('src="/a&quot;b.svg"');
    expect(html).toContain('href="/?q=&lt;x&gt;"');
    expect(html).not.toContain("<b>");
  });

  it("answers HEAD, refuses other methods and leaves unrelated paths alone", async () => {
    const head = get(ANDROID_CALLBACK_PATH, settings(), { method: "HEAD" })!;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(get(ANDROID_CALLBACK_PATH, settings(), { method: "POST" })!.status).toBe(405);
    expect(get(ASSET_LINKS_PATH, settings(), { method: "POST" })!.headers.get("allow")).toBe("GET, HEAD");
    expect(get("/android/callbacks")).toBeNull();
    expect(get("/")).toBeNull();
  });
});
