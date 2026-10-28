import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateEvent, allGiftRows } from "./src/aggregate.js";
import { advanceTimeline, ensureRanking, ensureTeamEvents, loadHome, publicCommunity, publicEvent } from "./src/sync.js";
import * as store from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4317);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" || Buffer.isBuffer(body) ? headers["Content-Type"] || "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function validSlug(slug) {
  return typeof slug === "string" && /^[A-Za-z0-9_-]+$/.test(slug);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function formatTokyo(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

async function handleApi(req, res, url) {
  const force = url.searchParams.get("refresh") === "1";
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/home") {
    return send(res, 200, await loadHome(force));
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "teams" && parts.length === 3) {
    const slug = parts[2];
    if (!validSlug(slug)) return send(res, 400, { error: "チーム名が不正です" });
    const { community, events } = await ensureTeamEvents(slug, force);
    const groups = { open: [], upcoming: [], closed: [] };
    for (const event of events) {
      const view = publicEvent(event);
      if (view.status === "upcoming") groups.upcoming.push(view);
      else if (view.status === "open") groups.open.push(view);
      else groups.closed.push(view);
    }
    groups.open.sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
    groups.upcoming.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    return send(res, 200, { community: publicCommunity(community), ...groups });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "teams" && parts[3] === "events" && parts.length === 5) {
    const slug = parts[2];
    const eventId = Number(parts[4]);
    if (!validSlug(slug) || !Number.isInteger(eventId)) return send(res, 400, { error: "指定が不正です" });
    await ensureTeamEvents(slug, false);
    const event = store.getEvent(slug, eventId);
    if (!event) return send(res, 404, { error: "イベントが見つかりません" });
    const ranking = await ensureRanking(slug, eventId, force);
    const aggregate = aggregateEvent(event);
    const community = store.communityBySlug(slug);
    return send(res, 200, {
      community: publicCommunity(community),
      event: publicEvent(event),
      ranking,
      aggregate,
    });
  }

  if (
    req.method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "teams" &&
    parts[3] === "events" &&
    parts[5] === "gifts.csv"
  ) {
    const slug = parts[2];
    const eventId = Number(parts[4]);
    if (!validSlug(slug) || !Number.isInteger(eventId)) return send(res, 400, { error: "指定が不正です" });
    const event = store.getEvent(slug, eventId);
    if (!event) return send(res, 404, { error: "イベントが見つかりません" });
    const aggregate = aggregateEvent(event);
    if (!aggregate.covered) return send(res, 409, { error: "先にギフト明細を集計してください" });
    const rows = allGiftRows(event).sort((a, b) => {
      const byTime = String(a.createdAt).localeCompare(String(b.createdAt));
      return byTime || a.postId - b.postId;
    });
    const titlesOf = (row) => (row.eventTitles?.length ? row.eventTitles : [event.title]);
    const eventCount = Math.max(1, ...rows.map((row) => titlesOf(row).length));
    const eventHeaders = eventCount === 1 ? ["イベント"] : Array.from({ length: eventCount }, (_, index) => `イベント${index + 1}`);
    const header = ["日時", ...eventHeaders, "ギフティング者", "ギフト先", "スタンプ", "ポイント", "返信", "投稿ID"];
    const lines = [header.join(",")];
    for (const row of rows) {
      const titles = titlesOf(row);
      lines.push(
        [
          formatTokyo(row.createdAt),
          ...eventHeaders.map((_, index) => titles[index] || ""),
          row.gifterName,
          row.recipientName,
          row.stampName,
          row.points,
          row.replyName,
          row.postId,
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    const body = `\uFEFF${lines.join("\n")}`;
    return send(res, 200, body, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="engate-event-${eventId}.csv"`,
    });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "teams" && parts[3] === "timeline") {
    const slug = parts[2];
    if (!validSlug(slug)) return send(res, 400, { error: "チーム名が不正です" });
    if (parts[4] === "reset") {
      store.resetTimeline(slug);
      return send(res, 200, { ok: true });
    }
    const body = await readBody(req);
    const until = typeof body.until === "string" ? body.until : null;
    const progress = await advanceTimeline(slug, {
      until,
      refreshHead: !!body.refreshHead,
      maxPages: 4,
    });
    return send(res, 200, progress);
  }

  return send(res, 404, { error: "APIが見つかりません" });
}

function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, relative));
  if (!filePath.startsWith(publicDir)) return send(res, 403, "forbidden");
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    return send(res, 200, fs.readFileSync(filePath), { "Content-Type": types[ext] || "application/octet-stream" });
  }
  return send(res, 200, fs.readFileSync(path.join(publicDir, "index.html")), {
    "Content-Type": "text/html; charset=utf-8",
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, error.status || 500, { error: error.message || "集計に失敗しました" });
  }
});

server.listen(port, () => {
  console.log(`engate events http://localhost:${port}`);
});
