import type { ProductCategory } from "../types.js";

export type ImportedProductImage = {
  filename: string;
  mime: string;
  dataUrl: string | null;
  sourceUrl: string;
};

export type ImportedProductDraft = {
  nombre: string;
  sku: string;
  descripcion: string;
  precio: number;
  categoria: ProductCategory;
  sourceUrl: string;
  images: ImportedProductImage[];
  warnings: string[];
};

const MAX_IMAGES = 6;
const MAX_HTML_BYTES = 3_000_000;
const FETCH_TIMEOUT_MS = 25_000;

function decodeEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
}

function metaContent(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m1 = html.match(re);
  if (m1?.[1]) return decodeEntities(m1[1].trim());
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
    "i"
  );
  const m2 = html.match(re2);
  return m2?.[1] ? decodeEntities(m2[1].trim()) : null;
}

function titleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m?.[1] ? decodeEntities(m[1].trim()) : null;
}

function parseArsPrice(raw: string): number | null {
  const cleaned = raw.replace(/[^\d.,]/g, "").trim();
  if (!cleaned) return null;
  if (/\.\d{3},\d{2}$/.test(cleaned) || /^\d{1,3}(\.\d{3})+,\d{2}$/.test(cleaned)) {
    const n = Number(cleaned.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  if (/^\d+,\d{2}$/.test(cleaned)) {
    const n = Number(cleaned.replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  const n = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseTiendaNubeCents(raw: string): number | null {
  const n = Number(String(raw).replace(/\D/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1000) return Math.round(n) / 100;
  return n;
}

function guessCategory(name: string, description: string): ProductCategory {
  const hay = `${name} ${description}`.toLowerCase();
  if (/bebida|gaseosa|agua|cerveza|vino|jugo|refresco|café|cafe/.test(hay)) {
    return "bebidas";
  }
  if (
    /alimento|comida|snack|galleta|dulce|pan|harina|queso|carne|lácteo|lacteo/.test(
      hay
    )
  ) {
    return "alimentos";
  }
  if (/limpieza|detergente|lavandina|jabón|jabon|desinfect/.test(hay)) {
    return "limpieza";
  }
  return "otros";
}

function absoluteUrl(href: string, pageUrl: string): string {
  const h = href.trim();
  if (!h) return "";
  if (h.startsWith("//")) return `https:${h}`;
  if (/^https?:\/\//i.test(h)) return h;
  try {
    return new URL(h, pageUrl).toString();
  } catch {
    return "";
  }
}

function productImageKey(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").pop() || url;
    return base.replace(/-\d{2,4}-\d+\.(webp|jpe?g|png)$/i, "").toLowerCase();
  } catch {
    return url;
  }
}

function imageScore(url: string): number {
  const m = url.match(/-(\d{2,4})-\d+\.(webp|jpe?g|png)/i);
  return m ? Number(m[1]) : 400;
}

function collectProductImageUrls(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  const push = (raw: string) => {
    const abs = absoluteUrl(raw, pageUrl);
    if (!abs) return;
    if (!/\.(webp|jpe?g|png)(\?|$)/i.test(abs)) return;
    if (/\/themes\//i.test(abs) || /logo/i.test(abs)) return;
    if (!/\/products?\//i.test(abs) && !/cdn/i.test(abs)) return;
    found.push(abs.split("?")[0]);
  };

  const og =
    metaContent(html, "og:image:secure_url") || metaContent(html, "og:image");
  if (og) push(og);

  const re =
    /(?:src|data-src|href)=["']([^"']+\.(?:webp|jpe?g|png)[^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    push(m[1]);
  }
  const srcset = /(?:srcset|imagesrcset)=["']([^"']+)["']/gi;
  while ((m = srcset.exec(html))) {
    for (const part of m[1].split(",")) {
      const url = part.trim().split(/\s+/)[0];
      if (url) push(url);
    }
  }

  const best = new Map<string, string>();
  for (const url of found) {
    if (!/\/products?\//i.test(url)) continue;
    const key = productImageKey(url);
    const prev = best.get(key);
    if (!prev || imageScore(url) > imageScore(prev)) best.set(key, url);
  }
  let urls = [...best.values()];
  if (!urls.length) {
    const seen = new Set<string>();
    for (const url of found) {
      const key = productImageKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(url);
    }
  }
  urls.sort((a, b) => imageScore(b) - imageScore(a));
  return urls.slice(0, MAX_IMAGES);
}

function extractSku(html: string): string {
  const patterns = [
    /SKU:\s*([A-Z0-9][A-Z0-9._\-/ ]{0,40})/i,
    /itemprop=["']sku["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*itemprop=["']sku["']/i,
    /"sku"\s*:\s*"([^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1].trim()).slice(0, 80);
  }
  return "";
}

function extractPrice(html: string): number | null {
  const priceDisplay = html.match(
    /id=["']price_display["'][^>]*data-product-price=["'](\d+)["']/i
  );
  if (priceDisplay?.[1]) {
    const n = parseTiendaNubeCents(priceDisplay[1]);
    if (n != null) return n;
  }
  const dataPrice = html.match(
    /data-product-price=["'](\d+)["'][^>]*id=["']price_display["']/i
  );
  if (dataPrice?.[1]) {
    const n = parseTiendaNubeCents(dataPrice[1]);
    if (n != null) return n;
  }
  const firstDisplay = html.match(
    /js-price-display[^>]*data-product-price=["'](\d+)["']/i
  );
  if (firstDisplay?.[1]) {
    const n = parseTiendaNubeCents(firstDisplay[1]);
    if (n != null && n >= 100) return n;
  }
  const textPrice = html.match(
    /id=["']price_display["'][^>]*>\s*\$?\s*([\d.\s]+,\d{2})/i
  );
  if (textPrice?.[1]) return parseArsPrice(textPrice[1]);
  const ogAmount = metaContent(html, "product:price:amount");
  if (ogAmount) {
    const n = Number(ogAmount.replace(",", "."));
    if (Number.isFinite(n)) return Math.round(n * 100) / 100;
  }
  return null;
}

function filenameFromUrl(url: string, mime: string): string {
  try {
    const base = new URL(url).pathname.split("/").pop() || "imagen";
    if (/\.(webp|jpe?g|png)$/i.test(base)) return base.slice(0, 180);
    const ext =
      mime === "image/webp" ? "webp" : mime === "image/png" ? "png" : "jpg";
    return `${base.slice(0, 120)}.${ext}`;
  } catch {
    return `producto-${Date.now()}.jpg`;
  }
}

async function fetchHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AurixRetailBot/1.0; +https://fenecstudio.com)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      throw new Error(`No se pudo abrir la URL (HTTP ${res.status}).`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_HTML_BYTES) {
      throw new Error("La página es demasiado grande para importar.");
    }
    return buf.toString("utf8");
  } finally {
    clearTimeout(t);
  }
}

async function downloadImageAsDataUrl(
  imageUrl: string
): Promise<{ dataUrl: string; mime: string; filename: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(imageUrl, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AurixRetailBot/1.0; +https://fenecstudio.com)",
        Accept: "image/*,*/*",
      },
    });
    if (!res.ok) return null;
    const mime =
      (res.headers.get("content-type") || "").split(";")[0].trim() ||
      "image/jpeg";
    if (!mime.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= 0 || buf.length > 6_000_000) return null;
    const filename = filenameFromUrl(imageUrl, mime);
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    return { dataUrl, mime, filename };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function importProductFromUrl(
  rawUrl: string
): Promise<ImportedProductDraft> {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("URL inválida.");
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error("La URL debe ser http o https.");
  }

  const sourceUrl = parsed.toString();
  const html = await fetchHtml(sourceUrl);
  const warnings: string[] = [];

  const nombreRaw =
    metaContent(html, "og:title") || titleTag(html) || "Producto importado";
  const descripcionRaw =
    metaContent(html, "og:description") ||
    metaContent(html, "description") ||
    "";
  const sku = extractSku(html);
  const precio = extractPrice(html) ?? 0;
  if (!precio) {
    warnings.push("No pudimos detectar el precio; revisalo a mano.");
  }
  if (!sku) {
    warnings.push("No encontramos SKU en la página.");
  }

  const imageUrls = collectProductImageUrls(html, sourceUrl);
  if (!imageUrls.length) {
    warnings.push("No encontramos fotos del producto.");
  }

  const images: ImportedProductImage[] = [];
  for (const imageUrl of imageUrls) {
    const downloaded = await downloadImageAsDataUrl(imageUrl);
    if (!downloaded) {
      warnings.push(`No se pudo descargar: ${imageUrl.slice(0, 80)}…`);
      continue;
    }
    images.push({
      filename: downloaded.filename,
      mime: downloaded.mime,
      dataUrl: downloaded.dataUrl,
      sourceUrl: imageUrl,
    });
  }

  return {
    nombre: nombreRaw.slice(0, 200),
    sku,
    descripcion: descripcionRaw.slice(0, 4000),
    precio,
    categoria: guessCategory(nombreRaw, descripcionRaw),
    sourceUrl,
    images,
    warnings,
  };
}
