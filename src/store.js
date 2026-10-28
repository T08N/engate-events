import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "engate.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS communities (
    id INTEGER PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    logo TEXT,
    color TEXT,
    followers INTEGER,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    community_id INTEGER,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    is_open INTEGER,
    is_future INTEGER,
    is_close INTEGER,
    image TEXT,
    targets_json TEXT,
    conditions_json TEXT,
    reward_type_json TEXT,
    description TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);
  CREATE TABLE IF NOT EXISTS team_sync (
    slug TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rankings (
    event_id INTEGER PRIMARY KEY,
    total_point INTEGER,
    participant_count INTEGER,
    rows_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seen_posts (
    slug TEXT NOT NULL,
    post_id INTEGER NOT NULL,
    created_at TEXT,
    PRIMARY KEY (slug, post_id)
  );
  CREATE TABLE IF NOT EXISTS gifts (
    post_id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL,
    created_at TEXT NOT NULL,
    gifter_id TEXT,
    gifter_name TEXT,
    gifter_avatar TEXT,
    recipient_id TEXT,
    recipient_name TEXT,
    recipient_is_team INTEGER,
    stamp_id TEXT,
    stamp_name TEXT,
    stamp_image TEXT,
    points INTEGER,
    reply_name TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gifts_slug_time ON gifts(slug, created_at);
  CREATE TABLE IF NOT EXISTS timeline_state (
    slug TEXT PRIMARY KEY,
    next_offset INTEGER NOT NULL DEFAULT 0,
    oldest_at TEXT,
    complete INTEGER NOT NULL DEFAULT 0,
    total_posts INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);

const eventColumns = db.prepare("PRAGMA table_info(events)").all();
if (!eventColumns.some((column) => column.name === "description")) {
  db.exec("ALTER TABLE events ADD COLUMN description TEXT");
}

const nowIso = () => new Date().toISOString();

export function getMeta(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row?.value ?? null;
}

export function setMeta(key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function saveCommunities(list) {
  const stamp = nowIso();
  const stmt = db.prepare(`
    INSERT INTO communities (id, slug, name, logo, color, followers, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      slug = excluded.slug,
      name = excluded.name,
      logo = excluded.logo,
      color = excluded.color,
      followers = excluded.followers,
      updated_at = excluded.updated_at
  `);
  db.exec("BEGIN");
  try {
    for (const community of list) {
      stmt.run(community.id, community.slug, community.name, community.logo, community.color, community.followers, stamp);
    }
    setMeta("communities_fetched_at", stamp);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listCommunities() {
  return db
    .prepare(
      "SELECT id, slug, name, logo, color, followers FROM communities ORDER BY followers DESC, name ASC",
    )
    .all();
}

export function communityById(id) {
  return db.prepare("SELECT id, slug, name, logo, color, followers FROM communities WHERE id = ?").get(id);
}

export function communityBySlug(slug) {
  return db.prepare("SELECT id, slug, name, logo, color, followers FROM communities WHERE slug = ?").get(slug);
}

function writeEvent(insert, slug, event, stamp) {
  insert.run(
    event.id,
    event.communityId,
    slug,
    event.title,
    event.startedAt,
    event.endedAt,
    event.isOpen,
    event.isFuture,
    event.isClose,
    event.image,
    JSON.stringify(event.targets || []),
    JSON.stringify(event.conditions || []),
    JSON.stringify(event.rewardType || []),
    event.description ?? null,
    stamp,
  );
}

export function upsertEvents(slug, events) {
  const stamp = nowIso();
  const insert = db.prepare(`
    INSERT INTO events (
      id, community_id, slug, title, started_at, ended_at, is_open, is_future, is_close,
      image, targets_json, conditions_json, reward_type_json, description, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      community_id = excluded.community_id,
      slug = excluded.slug,
      title = excluded.title,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      is_open = excluded.is_open,
      is_future = excluded.is_future,
      is_close = excluded.is_close,
      image = excluded.image,
      targets_json = excluded.targets_json,
      conditions_json = excluded.conditions_json,
      reward_type_json = excluded.reward_type_json,
      description = excluded.description,
      updated_at = excluded.updated_at
  `);
  const stillOpen = new Set(events.filter((event) => event.isOpen).map((event) => event.id));
  db.exec("BEGIN");
  try {
    for (const event of events) writeEvent(insert, slug, event, stamp);
    const current = db.prepare("SELECT id FROM events WHERE slug = ? AND is_open = 1").all(slug);
    const close = db.prepare("UPDATE events SET is_open = 0, is_close = 1, updated_at = ? WHERE id = ?");
    for (const row of current) {
      if (!stillOpen.has(row.id)) close.run(stamp, row.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveEvents(slug, events) {
  const stamp = nowIso();
  const remove = db.prepare("DELETE FROM events WHERE slug = ?");
  const insert = db.prepare(`
    INSERT INTO events (
      id, community_id, slug, title, started_at, ended_at, is_open, is_future, is_close,
      image, targets_json, conditions_json, reward_type_json, description, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const touch = db.prepare(`
    INSERT INTO team_sync (slug, fetched_at) VALUES (?, ?)
    ON CONFLICT(slug) DO UPDATE SET fetched_at = excluded.fetched_at
  `);
  db.exec("BEGIN");
  try {
    remove.run(slug);
    for (const event of events) writeEvent(insert, slug, event, stamp);
    touch.run(slug, stamp);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function hydrateEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    communityId: row.community_id,
    slug: row.slug,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    isOpen: row.is_open,
    isFuture: row.is_future,
    isClose: row.is_close,
    image: row.image,
    targets: JSON.parse(row.targets_json || "[]"),
    conditions: JSON.parse(row.conditions_json || "[]"),
    rewardType: JSON.parse(row.reward_type_json || "[]"),
    description: row.description ?? null,
    updatedAt: row.updated_at,
  };
}

export function listEvents(slug) {
  return db
    .prepare("SELECT * FROM events WHERE slug = ? ORDER BY started_at DESC")
    .all(slug)
    .map(hydrateEvent);
}

export function getEvent(slug, id) {
  return hydrateEvent(db.prepare("SELECT * FROM events WHERE slug = ? AND id = ?").get(slug, id));
}

export function saveEventDescription(id, description) {
  db.prepare("UPDATE events SET description = ? WHERE id = ?").run(description, id);
}

export function listEventsByIds(ids) {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM events WHERE id IN (${marks}) ORDER BY ended_at ASC`)
    .all(...ids)
    .map(hydrateEvent);
}

export function teamFetchedAt(slug) {
  return db.prepare("SELECT fetched_at FROM team_sync WHERE slug = ?").get(slug)?.fetched_at ?? null;
}

export function saveRanking(eventId, ranking) {
  const stamp = nowIso();
  db.prepare(`
    INSERT INTO rankings (event_id, total_point, participant_count, rows_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      total_point = excluded.total_point,
      participant_count = excluded.participant_count,
      rows_json = excluded.rows_json,
      updated_at = excluded.updated_at
  `).run(eventId, ranking.totalPoint, ranking.count, JSON.stringify(ranking.ranking), stamp);
}

export function getRanking(eventId) {
  const row = db.prepare("SELECT * FROM rankings WHERE event_id = ?").get(eventId);
  if (!row) return null;
  return {
    totalPoint: row.total_point,
    count: row.participant_count,
    ranking: JSON.parse(row.rows_json || "[]"),
    updatedAt: row.updated_at,
  };
}

export function getTimeline(slug) {
  const row = db.prepare("SELECT * FROM timeline_state WHERE slug = ?").get(slug);
  if (!row) {
    return { slug, nextOffset: 0, oldestAt: null, complete: 0, totalPosts: 0, updatedAt: null };
  }
  return {
    slug: row.slug,
    nextOffset: row.next_offset,
    oldestAt: row.oldest_at,
    complete: row.complete,
    totalPosts: row.total_posts,
    updatedAt: row.updated_at,
  };
}

export function setTimeline(state) {
  db.prepare(`
    INSERT INTO timeline_state (slug, next_offset, oldest_at, complete, total_posts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      next_offset = excluded.next_offset,
      oldest_at = excluded.oldest_at,
      complete = excluded.complete,
      total_posts = excluded.total_posts,
      updated_at = excluded.updated_at
  `).run(
    state.slug,
    state.nextOffset,
    state.oldestAt,
    state.complete ? 1 : 0,
    state.totalPosts || 0,
    nowIso(),
  );
}

export function seenSet(slug, postIds) {
  if (!postIds.length) return new Set();
  const marks = postIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT post_id FROM seen_posts WHERE slug = ? AND post_id IN (${marks})`)
    .all(slug, ...postIds);
  return new Set(rows.map((row) => row.post_id));
}

export function savePosts(slug, posts, mapGift) {
  if (!posts.length) return 0;
  const seen = db.prepare(`
    INSERT INTO seen_posts (slug, post_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(slug, post_id) DO NOTHING
  `);
  const gift = db.prepare(`
    INSERT INTO gifts (
      post_id, slug, created_at, gifter_id, gifter_name, gifter_avatar,
      recipient_id, recipient_name, recipient_is_team, stamp_id, stamp_name,
      stamp_image, points, reply_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      gifter_name = excluded.gifter_name,
      recipient_name = excluded.recipient_name,
      stamp_name = excluded.stamp_name,
      stamp_image = excluded.stamp_image,
      points = excluded.points,
      reply_name = excluded.reply_name
  `);
  let gifts = 0;
  db.exec("BEGIN");
  try {
    for (const post of posts) {
      seen.run(slug, Number(post.id), post.created_at || null);
      const row = mapGift(slug, post);
      if (!row) continue;
      gifts += 1;
      gift.run(
        row.postId,
        row.slug,
        row.createdAt,
        row.gifterId,
        row.gifterName,
        row.gifterAvatar,
        row.recipientId,
        row.recipientName,
        row.recipientIsTeam,
        row.stampId,
        row.stampName,
        row.stampImage,
        row.points,
        row.replyName,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return gifts;
}

export function countGifts(slug) {
  return db.prepare("SELECT COUNT(*) AS n FROM gifts WHERE slug = ?").get(slug).n;
}

export function queryGifts(slug, { from, to, recipientIds }) {
  const params = [slug];
  let sql = "SELECT * FROM gifts WHERE slug = ?";
  if (from) {
    sql += " AND created_at >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND created_at <= ?";
    params.push(to);
  }
  if (recipientIds?.length) {
    sql += ` AND recipient_id IN (${recipientIds.map(() => "?").join(",")})`;
    params.push(...recipientIds);
  }
  sql += " ORDER BY points DESC, created_at DESC";
  return db.prepare(sql).all(...params).map((row) => ({
    postId: row.post_id,
    createdAt: row.created_at,
    gifterId: row.gifter_id,
    gifterName: row.gifter_name,
    gifterAvatar: row.gifter_avatar,
    recipientId: row.recipient_id,
    recipientName: row.recipient_name,
    recipientIsTeam: row.recipient_is_team,
    stampId: row.stamp_id,
    stampName: row.stamp_name,
    stampImage: row.stamp_image,
    points: row.points,
    replyName: row.reply_name,
  }));
}

export function resetTimeline(slug) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM seen_posts WHERE slug = ?").run(slug);
    db.prepare("DELETE FROM gifts WHERE slug = ?").run(slug);
    db.prepare("DELETE FROM timeline_state WHERE slug = ?").run(slug);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
