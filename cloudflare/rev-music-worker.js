/**
 * REV Music Worker — deploy as a separate Cloudflare Worker.
 * Required binding: R2 bucket named MUSIC_BUCKET.
 * Required secret: ADMIN_TOKEN (set with wrangler secret or Dashboard; never commit it).
 * Public endpoints: GET /api/music/tracks, GET /music/<key>
 * Admin endpoints: POST /api/admin/music (multipart: file,title,artist), DELETE /api/admin/music/<id>
 */
const CATALOG_KEY = "_catalog.json";
const MAX_UPLOAD = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/wav", "audio/webm"]);
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = origin === "https://mojtabaalimi64-cloud.github.io";
  return {
    "Vary": "Origin",
    ...(allowed ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400"
  };
}
function safeName(s) {
  return String(s || "track").normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "track";
}
async function catalog(env) {
  const obj = await env.MUSIC_BUCKET.get(CATALOG_KEY);
  if (!obj) return [];
  try {
    const value = await obj.json();
    return Array.isArray(value.tracks) ? value.tracks : [];
  } catch { return []; }
}
async function saveCatalog(env, tracks) {
  await env.MUSIC_BUCKET.put(CATALOG_KEY, JSON.stringify({ tracks, updatedAt: new Date().toISOString() }), {
    httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "no-store" }
  });
}
function isAdmin(request, env) {
  const token = String(env.ADMIN_TOKEN || "");
  return token.length >= 24 && request.headers.get("Authorization") === "Bearer " + token;
}
async function serveAudio(request, env, key) {
  if (!/^tracks\/[a-zA-Z0-9_-]+\.(mp3|m4a|aac|ogg|wav|webm)$/i.test(key)) return new Response("Not found", { status: 404 });
  const range = request.headers.get("Range");
  const options = {};
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      if (match[1]) options.range = { offset: Number(match[1]), length: match[2] ? Number(match[2]) - Number(match[1]) + 1 : undefined };
      else if (match[2]) options.range = { suffix: Number(match[2]) };
    }
  }
  const object = await env.MUSIC_BUCKET.get(key, options);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("Access-Control-Allow-Origin", "https://mojtabaalimi64-cloud.github.io");
  headers.set("Content-Type", object.httpMetadata?.contentType || "audio/mpeg");
  if (object.range) {
    headers.set("Content-Range", `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
    headers.set("Content-Length", String(object.range.length));
    return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (url.pathname === "/api/health") return json({ success: true, service: "REV Music", storage: !!env.MUSIC_BUCKET }, 200, headers);
    if (url.pathname === "/api/music/tracks" && request.method === "GET") {
      const tracks = (await catalog(env)).map(({ id, title, artist, key }) => ({
        id, title, artist, src: new URL("/music/" + encodeURIComponent(key).replace(/%2F/g, "/"), url.origin).href
      }));
      return json({ success: true, tracks }, 200, headers);
    }
    if (url.pathname.startsWith("/music/") && ["GET", "HEAD"].includes(request.method)) {
      const key = decodeURIComponent(url.pathname.slice("/music/".length));
      return serveAudio(request, env, key);
    }
    if (url.pathname === "/api/admin/music" && request.method === "POST") {
      if (!isAdmin(request, env)) return json({ success: false, error: "دسترسی مدیریت تأیید نشد." }, 401, headers);
      let form;
      try { form = await request.formData(); } catch { return json({ success: false, error: "فرم بارگذاری معتبر نیست." }, 400, headers); }
      const file = form.get("file");
      const title = String(form.get("title") || "").trim().slice(0, 120);
      const artist = String(form.get("artist") || "").trim().slice(0, 120);
      if (!(file instanceof File) || !file.size || file.size > MAX_UPLOAD) return json({ success: false, error: "فایل خالی است یا از سقف ۲۰ مگابایت بیشتر است." }, 400, headers);
      if (!ALLOWED_TYPES.has(file.type)) return json({ success: false, error: "فرمت مجاز: MP3، M4A، AAC، OGG، WAV یا WebM." }, 415, headers);
      if (!title) return json({ success: false, error: "عنوان آهنگ الزامی است." }, 400, headers);
      const extByType = { "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/ogg": "ogg", "audio/wav": "wav", "audio/webm": "webm" };
      const id = crypto.randomUUID();
      const key = "tracks/" + id + "." + extByType[file.type];
      await env.MUSIC_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type, cacheControl: "public, max-age=86400" }, customMetadata: { title, artist } });
      const tracks = await catalog(env);
      tracks.unshift({ id, key, title, artist, size: file.size, type: file.type, createdAt: new Date().toISOString() });
      await saveCatalog(env, tracks);
      return json({ success: true, track: { id, title, artist, src: new URL("/music/" + key, url.origin).href } }, 201, headers);
    }
    const deleteMatch = /^\/api\/admin\/music\/([a-f0-9-]{36})$/i.exec(url.pathname);
    if (deleteMatch && request.method === "DELETE") {
      if (!isAdmin(request, env)) return json({ success: false, error: "دسترسی مدیریت تأیید نشد." }, 401, headers);
      const tracks = await catalog(env);
      const found = tracks.find(t => t.id === deleteMatch[1]);
      if (!found) return json({ success: false, error: "آهنگ پیدا نشد." }, 404, headers);
      await env.MUSIC_BUCKET.delete(found.key);
      await saveCatalog(env, tracks.filter(t => t.id !== found.id));
      return json({ success: true }, 200, headers);
    }
    return json({ success: false, error: "مسیر پیدا نشد." }, 404, headers);
  }
};
